// Compiled from workflow.json — analogy-quiz-generator
// sourceHash: b5c56107123f
// Generated: 2026-03-30

module.exports = {
  name: "analogy-quiz-generator",
  sourceHash: "317c90b79c04",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputs: {},
  steps: [
    {
      id: "gather-topic",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        return `Use the AskUserQuestion tool to ask the user what topic they'd like to be quizzed on. The question should be friendly and open-ended, e.g. 'What topic would you like a quiz question about? It can be anything — science, history, programming, philosophy, etc.' Return the user's chosen topic as your output.`;
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "find-analogy",
    },
    {
      id: "find-analogy",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const topic = ctx.steps["gather-topic"].output;
        return `The user wants to be quizzed on the following topic: "${topic}"

Given this topic, brainstorm and select one vivid, unexpected analogy domain that maps well onto the core concepts of that topic. For example, if the topic is 'TCP/IP networking', an analogy domain might be 'a postal service system'. Choose an analogy that is concrete, relatable, and structurally rich enough to support a quiz question. Output the analogy domain and a brief explanation of how it maps to the original topic (at least 3 mapping points between the analogy and the real topic).`;
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "map-situation",
    },
    {
      id: "map-situation",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const topic = ctx.steps["gather-topic"].output;
        const analogy = ctx.steps["find-analogy"].output;
        return `Original topic: "${topic}"

Analogy domain and mapping:
${analogy}

Using the analogy domain and mapping above, construct a specific scenario or situation described entirely within the analogy space. This scenario should encode a non-obvious truth or important principle about the original topic. The situation should be detailed enough to reason about but should NOT mention the original topic directly — it should be told purely in analogy terms. For example, if the analogy is 'postal service' for 'TCP/IP', describe a situation like 'A postmaster guarantees every letter arrives in order by requiring the recipient to send back a signed receipt for each letter before the next one is sent.'`;
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "formulate-question",
    },
    {
      id: "formulate-question",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const topic = ctx.steps["gather-topic"].output;
        const analogy = ctx.steps["find-analogy"].output;
        const situation = ctx.steps["map-situation"].output;
        return `Original topic: "${topic}"

Analogy domain and mapping:
${analogy}

Analogy scenario:
${situation}

Using the analogy scenario above, formulate a multiple-choice quiz question (4 options, exactly one correct). The question should present the analogy scenario and ask what principle or truth about the ORIGINAL topic ("${topic}") it illustrates. The correct answer should reveal a genuine insight about the original topic. The three wrong answers should be plausible but incorrect. Output the question text, the four options labeled A-D, and indicate which is correct along with a brief explanation of why.`;
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "deliver-quiz",
    },
    {
      id: "deliver-quiz",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const question = ctx.steps["formulate-question"].output;
        return `Here is a quiz question that was formulated:

${question}

Use the AskUserQuestion tool to present the quiz question to the user. Show the analogy scenario and the question text, then provide the four answer options (A, B, C, D) as selectable choices. Do NOT reveal the correct answer yet. Return the user's selected answer.`;
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "reveal-and-summarize",
    },
    {
      id: "reveal-and-summarize",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const topic = ctx.steps["gather-topic"].output;
        const analogy = ctx.steps["find-analogy"].output;
        const situation = ctx.steps["map-situation"].output;
        const question = ctx.steps["formulate-question"].output;
        const userAnswer = ctx.steps["deliver-quiz"].output;
        return `Original topic: "${topic}"

Analogy domain and mapping:
${analogy}

Analogy scenario:
${situation}

Quiz question and correct answer:
${question}

The user's selected answer: ${userAnswer}

Compare the user's answer to the correct answer. Use the AskUserQuestion tool to present the result: tell them whether they got it right or wrong, reveal the correct answer, and provide the full explanation. Explain how the analogy maps back to the original topic, what truth it illustrates, and why the correct answer is correct. Make it educational and encouraging regardless of whether they answered correctly. End by asking if they'd like another question on a different topic.`;
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: null,
    },
  ],
};
