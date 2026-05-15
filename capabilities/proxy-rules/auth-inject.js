// Injects OAuth credentials into requests that arrive without auth headers.
// Useful when spawning claude with --bare, which skips OAuth/keychain reads.
// Reads the token from ~/.claude/.credentials.json and caches it in memory.
// Enable this rule to allow --bare with Max/Pro subscriptions (OAuth-based auth).

const fs = require('fs');
const os = require('os');
const path = require('path');

let _cachedToken = null;
let _cachedExpiry = 0;

function getOAuthToken() {
  if (_cachedToken && Date.now() < _cachedExpiry - 60000) return _cachedToken;
  try {
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken) {
      _cachedToken = oauth.accessToken;
      _cachedExpiry = oauth.expiresAt || 0;
      return _cachedToken;
    }
  } catch {}
  return null;
}

module.exports = async function(ctx) {
  if (ctx.req.headers['authorization'] || ctx.req.headers['x-api-key']) return;
  const token = getOAuthToken();
  if (token) {
    ctx.req.headers['authorization'] = `Bearer ${token}`;
  }
};
