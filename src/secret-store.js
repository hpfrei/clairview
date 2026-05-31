// Encrypted JSON secret store (AES-256-GCM). Single mechanism for at-rest
// secrets in core. The encryption key comes from VISTA_SECRETS_KEY (64 hex
// chars) or a 0600 keyfile auto-generated next to the store.
//
// readSecretFile/writeSecretFile operate on an arbitrary JSON object so callers
// keep their own shape. A plaintext predecessor file is migrated on first read
// (decrypt-or-fall-back), then encrypted on the next write.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function resolveKey(keyDir) {
  if (process.env.VISTA_SECRETS_KEY) return process.env.VISTA_SECRETS_KEY;
  const keyFile = path.join(keyDir, '.secrets_key');
  try {
    return fs.readFileSync(keyFile, 'utf-8').trim();
  } catch {
    const key = crypto.randomBytes(32).toString('hex');
    try {
      if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
    } catch {}
    return key;
  }
}

function encrypt(obj, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let enc = cipher.update(JSON.stringify(obj), 'utf-8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag, data: enc });
}

function decrypt(raw, keyHex) {
  const { iv, tag, data } = JSON.parse(raw);
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let dec = decipher.update(data, 'hex', 'utf-8');
  dec += decipher.final('utf-8');
  return JSON.parse(dec);
}

/**
 * Read an encrypted secret file. If `encPath` is absent but a plaintext
 * `legacyPath` exists, read it (migration path — the next write encrypts it and
 * the caller should delete the legacy file). Returns `fallback` on any failure.
 */
function readSecretFile(encPath, keyDir, { legacyPath, fallback = {} } = {}) {
  const keyHex = resolveKey(keyDir);
  try {
    const raw = fs.readFileSync(encPath, 'utf-8');
    return decrypt(raw, keyHex);
  } catch {}
  if (legacyPath) {
    try {
      return JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    } catch {}
  }
  return fallback;
}

/**
 * Write an object to `encPath` encrypted. If `legacyPath` is given and exists,
 * remove it after a successful encrypted write (completes the migration).
 */
function writeSecretFile(encPath, obj, keyDir, { legacyPath } = {}) {
  const keyHex = resolveKey(keyDir);
  const dir = path.dirname(encPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(encPath, encrypt(obj, keyHex), { mode: 0o600 });
  if (legacyPath && legacyPath !== encPath) {
    try { if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath); } catch {}
  }
}

module.exports = { readSecretFile, writeSecretFile };
