// ============================================================
// Provider registry — maps provider IDs to adapter instances
// ============================================================

const OpenAIProvider = require('./openai');
const OpenAIResponsesProvider = require('./openai-responses');
const GeminiProvider = require('./gemini');

const providers = {
  openai: new OpenAIProvider(),
  'openai-responses': new OpenAIResponsesProvider(),
  gemini: new GeminiProvider(),
};

function getProvider(providerName) {
  return providers[providerName] || null;
}

module.exports = { getProvider };
