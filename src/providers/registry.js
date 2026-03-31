// ============================================================
// Provider registry — maps provider IDs to adapter instances
// ============================================================

const OpenAIProvider = require('./openai');
const GeminiProvider = require('./gemini');

const providers = {
  openai: new OpenAIProvider(),
  gemini: new GeminiProvider(),
};

function getProvider(providerName) {
  return providers[providerName] || null;
}

module.exports = { getProvider };
