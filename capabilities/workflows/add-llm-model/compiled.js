const WORKFLOW_NAME = "add-llm-model";
const TOOL_NAME = "add_llm_model";
const SELF_TOOL = "mcp__integrated__add_llm_model";

const preamble = (stepId) =>
  `[Workflow context: you are executing step "${stepId}" of the "${WORKFLOW_NAME}" workflow. ` +
  `This workflow is exposed as the MCP tool "${TOOL_NAME}". ` +
  `Do NOT call the ${TOOL_NAME} tool — you are already inside it. Complete your task directly.]\n\n`;

module.exports = {
  name: WORKFLOW_NAME,
  description:
    "Add a new LLM model to vistaclair by validating it uses an existing adapter, gathering model details, and writing the entry to models.json",
  sourceHash: "c7a5da3d7f54",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  inputs: {
    model_name: {
      type: "string",
      required: true,
      description:
        "Name or identifier of the model to add (e.g. 'gpt-4o', 'claude-3.5-sonnet', 'gemini-2.0-flash')",
    },
  },
  steps: [
    {
      id: "research-and-validate",
      profile: "full",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const modelName = ctx.inputs.model_name;
        return (
          preamble("research-and-validate") +
          `You are researching and validating the LLM model "${modelName}" so it can be added to a dashboard's model registry.\n\n` +
          `Follow these steps exactly, using the specified tools:\n\n` +
          `**Step 1 — Read the current model registry.**\n` +
          `Use the Read tool to read the file \`capabilities/models.json\`. Study the structure carefully:\n` +
          `- The top-level "providers" map: each key is a providerKey with "label" and optionally "apiBaseUrl".\n` +
          `- The "models" array: each entry has these fields: name, label, description, providerKey, provider (adapter name — one of "openai", "gemini", or "anthropic"), modelId, systemPromptMode, reasoning (boolean), contextWindow, maxOutputTokens, inputCostPerMTok, outputCostPerMTok, cacheReadCostPerMTok, cacheCreateCostPerMTok. Some entries also have useMaxCompletionTokens (boolean).\n` +
          `- Check whether a model named "${modelName}" (or similar) already exists in the models array.\n\n` +
          `**Step 2 — Confirm available adapters.**\n` +
          `Use the Read tool to read \`src/providers/registry.js\`. The system has exactly three adapters:\n` +
          `- "openai" — handles OpenAI, DeepSeek, Moonshot/Kimi, and any OpenAI-compatible API\n` +
          `- "gemini" — Google Gemini native API\n` +
          `- "anthropic" — implicit passthrough (not in the registry file; requests go directly to the Anthropic API)\n\n` +
          `**Step 3 — Research the model's specifications.**\n` +
          `Use the WebSearch tool to look up the specs for "${modelName}". Search for:\n` +
          `- The provider/company that makes it\n` +
          `- The exact API model ID string to use in API calls\n` +
          `- Context window size (in tokens)\n` +
          `- Maximum output tokens\n` +
          `- Whether it supports reasoning/thinking mode\n` +
          `- Pricing: input cost, output cost, cache read cost, and cache creation cost (all per million tokens)\n` +
          `- What API format it uses (OpenAI-compatible, Gemini native, or Anthropic native)\n` +
          `If a WebSearch doesn't return enough detail, use WebFetch on relevant documentation pages.\n\n` +
          `**Step 4 — Validate compatibility.**\n` +
          `Check these conditions:\n` +
          `1. The model's API format must be compatible with one of the three adapters. If it uses an OpenAI-compatible API (even from a third-party provider like Mistral, Groq, etc.), the "openai" adapter works.\n` +
          `2. The model must NOT already exist in the models array (check the "name" field of every entry you read in Step 1).\n\n` +
          `**Output your results:**\n\n` +
          `If validation FAILS (incompatible API format or model already exists), output:\n` +
          `VALIDATION FAILED: [clear explanation of why]\n\n` +
          `If validation PASSES, output all gathered details in this exact structured format:\n\n` +
          "```\n" +
          `MODEL RESEARCH RESULTS\n` +
          `Model Name: [the name to use as the "name" field]\n` +
          `Label: [human-readable label]\n` +
          `Description: [one-line description of the model]\n` +
          `Provider/Company: [who makes it]\n` +
          `Adapter: [openai, gemini, or anthropic]\n` +
          `Provider Key: [the key to use in the providers map, e.g. "openai", "google", "deepseek", or a new one]\n` +
          `API Model ID: [exact model ID string for API calls]\n` +
          `Reasoning: [true or false]\n` +
          `Context Window: [number]\n` +
          `Max Output Tokens: [number]\n` +
          `Input Cost Per MTok: [number]\n` +
          `Output Cost Per MTok: [number]\n` +
          `Cache Read Cost Per MTok: [number]\n` +
          `Cache Create Cost Per MTok: [number]\n` +
          `System Prompt Mode: [passthrough for Anthropic models, replace for all others]\n` +
          `Use Max Completion Tokens: [true ONLY for direct OpenAI models (providerKey "openai"), false otherwise]\n` +
          `New Provider Needed: [yes/no — if yes, include label and apiBaseUrl]\n` +
          "```\n\n" +
          `Mark any values you could not confirm with "UNKNOWN — needs user input".\n` +
          `Do NOT modify any files. This step is research only.`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "confirm-and-write",
    },
    {
      id: "confirm-and-write",
      profile: "full",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const modelName = ctx.inputs.model_name;
        const research = ctx.steps["research-and-validate"].output;
        return (
          preamble("confirm-and-write") +
          `You are adding the model "${modelName}" to the vistaclair model registry based on research from a previous step.\n\n` +
          `Here is the research output from the previous step:\n\n` +
          `--- RESEARCH OUTPUT ---\n${research}\n--- END RESEARCH OUTPUT ---\n\n` +
          `**Check for validation failure first.**\n` +
          `If the research output above contains "VALIDATION FAILED", do NOT write any files. Instead:\n` +
          `- Use the AskUserQuestion tool to explain to the user why the model "${modelName}" cannot be added. Include the specific reason from the research.\n` +
          `- Provide these options: "Understood" and "Try a different model".\n` +
          `- After the user responds, output a summary of what happened and stop.\n\n` +
          `**If validation passed, proceed with these steps:**\n\n` +
          `**Step 1 — Build the JSON entry.**\n` +
          `Using the research data above, construct a complete JSON object for the model entry. The schema must match exactly:\n` +
          "```json\n" +
          `{\n` +
          `  "name": "<model name>",\n` +
          `  "label": "<human-readable label>",\n` +
          `  "description": "<one-line description>",\n` +
          `  "providerKey": "<provider key>",\n` +
          `  "provider": "<adapter: openai, gemini, or anthropic>",\n` +
          `  "modelId": "<API model ID>",\n` +
          `  "systemPromptMode": "<passthrough or replace>",\n` +
          `  "reasoning": <true or false>,\n` +
          `  "contextWindow": <number>,\n` +
          `  "maxOutputTokens": <number>,\n` +
          `  "inputCostPerMTok": <number>,\n` +
          `  "outputCostPerMTok": <number>,\n` +
          `  "cacheReadCostPerMTok": <number>,\n` +
          `  "cacheCreateCostPerMTok": <number>\n` +
          `}\n` +
          "```\n" +
          `Only include "useMaxCompletionTokens": true if the providerKey is "openai" (direct OpenAI models).\n` +
          `If a new provider is needed, also build the provider entry: { "label": "...", "apiBaseUrl": "..." }.\n\n` +
          `**Step 2 — Get user confirmation.**\n` +
          `Use the AskUserQuestion tool to present the complete JSON entry to the user. In the question text, show the formatted JSON entry and flag any values marked as "UNKNOWN" or that were estimated. Ask them to confirm or request adjustments. Provide options like "Looks good, add it" and "I want to make changes".\n` +
          `If the user wants changes, use AskUserQuestion again to ask what they'd like to change, incorporate the changes, and confirm again.\n\n` +
          `**Step 3 — Write the file.**\n` +
          `Once confirmed:\n` +
          `1. Use the Read tool to read \`capabilities/models.json\` to get the current content.\n` +
          `2. Parse the JSON, append the new model entry to the "models" array. If a new provider is needed, add it to the "providers" map.\n` +
          `3. Use the Write tool to write the updated JSON back to \`capabilities/models.json\` with 2-space indentation and a trailing newline.\n\n` +
          `Output a summary of what was written: the model name, adapter, and providerKey.`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "verify",
    },
    {
      id: "verify",
      profile: "readonly",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const modelName = ctx.inputs.model_name;
        const writeResult = ctx.steps["confirm-and-write"].output;
        return (
          preamble("verify") +
          `You are verifying that the model "${modelName}" was correctly added to the model registry.\n\n` +
          `Here is the output from the previous step that wrote the file:\n\n` +
          `--- WRITE STEP OUTPUT ---\n${writeResult}\n--- END WRITE STEP OUTPUT ---\n\n` +
          `**If the previous step indicates the model was NOT added** (validation failure, user declined, or any other reason), simply acknowledge that the model was not added and output a brief explanation. Do not attempt verification.\n\n` +
          `**If the model was added, perform these verification checks:**\n\n` +
          `1. Use the Read tool to read \`capabilities/models.json\`.\n` +
          `2. Verify the file is valid JSON (it parsed without error).\n` +
          `3. Search the "models" array for an entry whose "name" field matches "${modelName}" or the derived name from the previous step.\n` +
          `4. Verify the entry has ALL required fields: name, label, description, providerKey, provider, modelId, systemPromptMode, reasoning, contextWindow, maxOutputTokens, inputCostPerMTok, outputCostPerMTok, cacheReadCostPerMTok, cacheCreateCostPerMTok.\n` +
          `5. If a new provider was added, verify it exists in the "providers" map with label and apiBaseUrl.\n\n` +
          `**Output a concise summary:**\n` +
          `- Model name, label, adapter (provider field), providerKey, and modelId\n` +
          `- Whether all fields are present and valid\n` +
          `- Remind the user: "Don't forget to add your API key in \`capabilities/secrets.json\` under \`providerKeys.<providerKey>\` if you haven't already."\n` +
          `  (Replace <providerKey> with the actual providerKey value from the model entry.)`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: null,
    },
  ],
};
