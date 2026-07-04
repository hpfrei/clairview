// Telegram device-code login for the dashboard.
//
// Flow: the login page requests a challenge (short code + browser-held nonce),
// the owner sends the code to their personal login bot, the long-poller sees it
// (sender must be the configured owner), and the browser's next poll with the
// matching nonce is issued a session. The page can never trigger bot messages —
// possession of the Telegram chat is the identity proof.
//
// Works identically on a home PC and a server: getUpdates long-polling needs no
// inbound URL. The bot must be dedicated to login (one getUpdates consumer per
// bot token); Pro's per-app bots are separate.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readSecretFile, writeSecretFile } = require('./secret-store');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const LINK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_DAYS = 30;

function randomCode() {
  let code = 'VC-';
  const bytes = crypto.randomBytes(5);
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function createTgLogin({ dataHome }) {
  const configPath = path.join(dataHome, 'tg-login.enc');
  const sessionsPath = path.join(dataHome, 'sessions.json');

  let config = readSecretFile(configPath, dataHome, { fallback: {} });

  // Sessions persist across restarts (pm2 reload must not log the owner out).
  // Only sid hashes are stored — a disk read can't yield a usable cookie.
  let sessions = [];
  try { sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')); } catch {}
  function saveSessions() {
    try {
      fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    } catch (e) { console.error('  tg-login: failed to persist sessions:', e.message); }
  }
  function pruneSessions() {
    const now = Date.now();
    const before = sessions.length;
    sessions = sessions.filter(s => s.expiresAt > now);
    if (sessions.length !== before) saveSessions();
  }

  const challenges = new Map(); // nonce -> { code, createdAt, approved, ip, ua }
  const oneTimeLinks = new Map(); // key -> expiresAt

  function sessionTtlMs() {
    const days = Number(config.sessionTtlDays) || DEFAULT_SESSION_TTL_DAYS;
    return days * 24 * 60 * 60 * 1000;
  }

  function createSession({ ip, ua, via }) {
    pruneSessions();
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.push({
      id: crypto.randomBytes(6).toString('hex'),
      sidHash: sha256(sid),
      createdAt: Date.now(),
      expiresAt: Date.now() + sessionTtlMs(),
      ip: ip || null,
      ua: (ua || '').slice(0, 200) || null,
      via: via || 'telegram',
    });
    saveSessions();
    return sid;
  }

  function getSession(sid) {
    if (!sid || typeof sid !== 'string') return null;
    const hash = sha256(sid);
    const s = sessions.find(x => x.sidHash === hash);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { pruneSessions(); return null; }
    return s;
  }

  function listSessions(currentSid) {
    pruneSessions();
    const currentHash = currentSid ? sha256(currentSid) : null;
    return sessions.map(s => ({
      id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt,
      ip: s.ip, ua: s.ua, via: s.via,
      current: s.sidHash === currentHash,
    }));
  }

  function revokeSession(id) {
    const before = sessions.length;
    sessions = sessions.filter(s => s.id !== id);
    if (sessions.length !== before) { saveSessions(); return true; }
    return false;
  }

  function revokeAll({ exceptSid } = {}) {
    const keepHash = exceptSid ? sha256(exceptSid) : null;
    sessions = sessions.filter(s => s.sidHash === keepHash);
    saveSessions();
  }

  function configured() {
    return !!(config.botToken && config.ownerUserId);
  }

  function setConfig({ botToken, ownerUserId, sessionTtlDays }) {
    config = {
      ...config,
      ...(botToken !== undefined ? { botToken: String(botToken).trim() } : {}),
      ...(ownerUserId !== undefined ? { ownerUserId: String(ownerUserId).trim() } : {}),
      ...(sessionTtlDays !== undefined ? { sessionTtlDays: Number(sessionTtlDays) } : {}),
    };
    if (!config.botToken) delete config.botToken;
    if (!config.ownerUserId) delete config.ownerUserId;
    writeSecretFile(configPath, config, dataHome);
    restartPoller();
  }

  function getConfigInfo() {
    return {
      configured: configured(),
      ownerUserId: config.ownerUserId || null,
      botTokenSet: !!config.botToken,
      sessionTtlDays: Number(config.sessionTtlDays) || DEFAULT_SESSION_TTL_DAYS,
    };
  }

  // --- Challenges ---

  function pruneChallenges() {
    const now = Date.now();
    for (const [nonce, ch] of challenges) {
      if (now - ch.createdAt > CHALLENGE_TTL_MS) challenges.delete(nonce);
    }
  }

  function startChallenge({ ip, ua }) {
    pruneChallenges();
    if (challenges.size > 50) return null; // flood guard; limiter is the main gate
    const nonce = crypto.randomBytes(16).toString('hex');
    const code = randomCode();
    challenges.set(nonce, { code, createdAt: Date.now(), approved: false, ip, ua });
    return { nonce, code, expiresInMs: CHALLENGE_TTL_MS };
  }

  // Returns 'pending' | 'expired' | { sid } (single-use: challenge deleted on issue).
  function pollChallenge(nonce) {
    pruneChallenges();
    const ch = challenges.get(nonce);
    if (!ch) return 'expired';
    if (!ch.approved) return 'pending';
    challenges.delete(nonce);
    return { sid: createSession({ ip: ch.ip, ua: ch.ua, via: 'telegram' }) };
  }

  // --- One-time login links (break-glass, minted host-locally) ---

  function createOneTimeLink() {
    for (const [k, exp] of oneTimeLinks) { if (exp <= Date.now()) oneTimeLinks.delete(k); }
    const key = crypto.randomBytes(32).toString('hex');
    oneTimeLinks.set(key, Date.now() + LINK_TTL_MS);
    return key;
  }

  function redeemOneTimeLink(key, { ip, ua } = {}) {
    if (!key || typeof key !== 'string') return null;
    const exp = oneTimeLinks.get(key);
    oneTimeLinks.delete(key); // single-use even on expiry race
    if (!exp || exp <= Date.now()) return null;
    return createSession({ ip, ua, via: 'login-link' });
  }

  // --- Telegram long-poller ---

  let pollerGeneration = 0;
  let pollerRunning = false;

  async function tgApi(method, params, { timeoutMs = 65000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const apiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
      const res = await fetch(`${apiBase}/bot${config.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params || {}),
        signal: ctrl.signal,
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
      clearTimeout(timer);
    }
  }

  function handleMessage(msg) {
    const from = String(msg?.from?.id ?? '');
    // Everything not from the owner is dropped silently — no oracle, no replies.
    if (!from || from !== String(config.ownerUserId)) return;
    const text = String(msg.text || '').trim().toUpperCase();
    if (!text) return;
    pruneChallenges();
    let matched = null;
    for (const ch of challenges.values()) {
      if (!ch.approved && ch.code === text) { matched = ch; break; }
    }
    const chatId = msg.chat?.id;
    if (matched) {
      matched.approved = true;
      const where = [matched.ip && `IP ${matched.ip}`, matched.ua].filter(Boolean).join(', ');
      tgApi('sendMessage', { chat_id: chatId, text: `✓ Logged in${where ? ` (${where})` : ''}` }).catch(() => {});
    } else if (/^VC-[A-Z0-9]{5}$/.test(text)) {
      tgApi('sendMessage', { chat_id: chatId, text: 'Code not recognized or expired. Reload the login page for a fresh code.' }).catch(() => {});
    }
  }

  async function pollLoop(generation) {
    let offset = 0;
    let backoffMs = 1000;
    while (generation === pollerGeneration && configured()) {
      try {
        const { status, body } = await tgApi('getUpdates', {
          offset, timeout: 50, allowed_updates: ['message'],
        });
        if (generation !== pollerGeneration) return;
        if (status === 409) {
          // Another consumer (webhook or second poller) owns this bot.
          console.error('  tg-login: getUpdates conflict (409) — is the bot used elsewhere? Use a dedicated login bot.');
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }
        if (status === 401) {
          console.error('  tg-login: bot token rejected (401) — check configuration.');
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }
        if (!body.ok) throw new Error(body.description || `HTTP ${status}`);
        backoffMs = 1000;
        for (const upd of body.result || []) {
          offset = Math.max(offset, upd.update_id + 1);
          if (upd.message) {
            try { handleMessage(upd.message); } catch (e) { console.error('  tg-login: handler error:', e.message); }
          }
        }
      } catch (e) {
        if (generation !== pollerGeneration) return;
        if (e.name !== 'AbortError') console.error('  tg-login: poll error:', e.message);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60000);
      }
    }
  }

  function restartPoller() {
    pollerGeneration++;
    if (configured()) {
      pollerRunning = true;
      pollLoop(pollerGeneration).finally(() => { pollerRunning = false; });
      console.log('  tg-login: poller started');
    } else if (pollerRunning) {
      console.log('  tg-login: poller stopped (unconfigured)');
    }
  }

  function start() {
    pruneSessions();
    if (configured()) restartPoller();
  }

  function stop() {
    pollerGeneration++;
  }

  return {
    configured, setConfig, getConfigInfo,
    startChallenge, pollChallenge,
    createSession, getSession, listSessions, revokeSession, revokeAll,
    createOneTimeLink, redeemOneTimeLink,
    start, stop,
  };
}

module.exports = { createTgLogin };
