// Headless addon-host context: the frozen-seam subset of the addonCtx that
// server.js hands to add-ons, for consumers running OUTSIDE the dashboard
// process (Pro's app-runner). Signatures mirror server.js's addonCtx exactly —
// they are part of the addon contract and must stay compatible with it.
//
// Core services that live in the dashboard process (broadcaster, inspector
// store) are reached best-effort over loopback: the runner keeps serving when
// core is down, it just loses live dashboard events and inspector timelines.

const crypto = require('crypto');
const { DATA_HOME, spawnClaude, buildClaudeArgs } = require('./utils');
const caps = require('./capabilities');
const secretStore = require('./secret-store');

const CONTRACT_VERSION = 1;

function createHeadlessCtx({ dataHome = DATA_HOME } = {}) {
  const proxyPort = parseInt(process.env.PROXY_PORT || '3456');
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '3457');
  const authToken = process.env.AUTH_TOKEN || null;

  // Fire-and-forget loopback relay to the dashboard's broadcaster. No queue,
  // no retry: dashboard events are ephemeral UI state.
  function relayBroadcast(msg) {
    if (!authToken) return;
    fetch(`http://127.0.0.1:${dashboardPort}/api/internal/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vistaclair-internal': authToken },
      body: JSON.stringify(msg),
    }).catch(() => {});
  }

  return {
    contractVersion: CONTRACT_VERSION,
    headless: true,
    dashboardPort,
    proxyPort,
    authToken,
    broadcaster: { broadcast: relayBroadcast },
    spawnClaude,
    buildClaudeArgs,
    // Inspector session registration is dashboard-process state; headless
    // spawns still work (the proxy tags them by instanceId), they just don't
    // get a persistent per-session timeline.
    registerAiSession: () => crypto.randomUUID(),
    unregisterAiSession: () => {},
    secretStore,
    resolveHeadlessAuth: (authMode) => caps.resolveHeadlessAuth(dataHome, authMode),
    resolveProviderKey: (providerKey) => caps.getProviderKey(dataHome, providerKey),
    setProviderKey: (providerKey, apiKey) => caps.setProviderKey(dataHome, providerKey, apiKey),
    listModels: () => caps.listModels(dataHome),
    claudeAuthInfo: () => ({
      hasSubscription: caps.hasClaudeSubscription(),
      pref: caps.getClaudeAuthPref(dataHome),
      needsChoice: caps.needsClaudeAuthChoice(dataHome),
    }),
  };
}

module.exports = { createHeadlessCtx, CONTRACT_VERSION };
