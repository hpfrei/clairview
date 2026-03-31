// ============================================================
// Base provider adapter interface
// ============================================================

class BaseProvider {
  /**
   * Translate an Anthropic Messages API request body into the target provider's format.
   * @param {object} body - Anthropic request body (model, system, messages, tools, stream, etc.)
   * @param {object} modelDef - Model definition from models.json
   * @returns {object} { url, headers, body } ready to send to the provider
   */
  translateRequest(body, modelDef) {
    throw new Error('translateRequest not implemented');
  }

  /**
   * Translate a single SSE chunk from the provider's format into Anthropic SSE events.
   * @param {string} data - Raw SSE data field (already parsed from "data: ..." line)
   * @param {object} streamState - Mutable state object maintained across chunks
   * @returns {string[]} Array of SSE event strings to send back (each is "event: ...\ndata: ...\n\n")
   */
  translateSSEChunk(data, streamState) {
    throw new Error('translateSSEChunk not implemented');
  }

  /**
   * Create a fresh stream state object for a new response stream.
   * @returns {object}
   */
  createStreamState() {
    return {};
  }

  /**
   * Safety-net finalization called by proxy when the upstream stream ends.
   * Override in subclasses to emit closing Anthropic SSE events if the stream
   * ended without explicit finalization (e.g. Gemini has no [DONE] sentinel).
   * @param {object} streamState
   * @returns {string[]} Array of SSE event strings (empty if already finalized)
   */
  finalizeStream(streamState) {
    return [];
  }
}

module.exports = BaseProvider;
