// Add-on registry — the generic plugin surface for VistaClair.
//
// Core stays add-on-agnostic for every additive transport: HTTP routes, client
// assets, WebSocket upgrades, and auth-exempt paths all flow through here as a
// versioned descriptor returned by each add-on's init(core). The only thing the
// composition root (server.js) still knows by name is which add-on to *install
// and license* — that part is inherently product-specific.
//
// Descriptor shape (contractVersion CONTRACT_VERSION):
//   {
//     contractVersion, id, productSlug,
//     router,                 // express.Router mounted after auth
//     clientModules: [{ styles, scripts }],
//     authExemptPaths: [...],     // public route prefixes (e.g. OAuth callbacks)
//     authExemptPatterns: [...],  // public route RegExps (e.g. per-app telegram mini-app assets)
//     handleUpgrade(req, socket, head) -> bool,
//     shutdown(), update(),    // optional lifecycle hooks
//     _module,                 // raw module handle (licensing/lifecycle)
//   }

const CONTRACT_VERSION = 1;

const addons = [];

function registerAddon(descriptor) {
  if (!descriptor) return null;
  if (descriptor.contractVersion !== CONTRACT_VERSION) {
    console.error(`  Addon "${descriptor.id || '?'}": contract v${descriptor.contractVersion} != core v${CONTRACT_VERSION} — skipped`);
    return null;
  }
  addons.push(descriptor);
  return descriptor;
}

function getAddon(id) {
  return addons.find(a => a.id === id) || null;
}

function removeAddon(id) {
  const i = addons.findIndex(a => a.id === id);
  if (i >= 0) addons.splice(i, 1);
}

// Concatenated client asset modules across all add-ons (order = registration).
function getClientModules() {
  return addons.flatMap(a => a.clientModules || []);
}

// True if a request path is declared public by any add-on. Matches the exact
// path or a path-segment prefix (p + '/...') — never a bare string prefix, so
// '/pro/auth/google/callback' can't be widened to '/pro/auth/google/callbackX'.
function isAuthExempt(reqPath) {
  for (const a of addons) {
    for (const p of a.authExemptPaths || []) {
      if (reqPath === p || reqPath.startsWith(p + '/')) return true;
    }
    for (const rx of a.authExemptPatterns || []) {
      try { if (rx.test(reqPath)) return true; } catch {}
    }
  }
  return false;
}

// Offer a WS upgrade to each add-on; first to claim it wins.
function handleUpgrade(req, socket, head) {
  for (const a of addons) {
    if (!a.handleUpgrade) continue;
    try {
      if (a.handleUpgrade(req, socket, head)) return true;
    } catch (e) {
      console.error(`  Addon "${a.id}" handleUpgrade error:`, e.message);
    }
  }
  return false;
}

// Mount every add-on's router on the host app (call after the auth middleware).
function mountRouters(app) {
  for (const a of addons) {
    if (a.router) app.use(a.router);
  }
}

function shutdownAll() {
  for (const a of addons) {
    try { a.shutdown?.(); } catch {}
  }
}

module.exports = {
  CONTRACT_VERSION,
  registerAddon,
  getAddon,
  removeAddon,
  getClientModules,
  isAuthExempt,
  handleUpgrade,
  mountRouters,
  shutdownAll,
  getAddons: () => addons,
};
