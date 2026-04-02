const WORKFLOW_NAME = "analogy-quiz-generator";
const TOOL_NAME = "analogy_quiz_generator";
const SELF_TOOL = "mcp__integrated__analogy_quiz_generator";

const preamble = (stepId) =>
  `[Workflow context: you are executing step "${stepId}" of the "${WORKFLOW_NAME}" workflow. ` +
  `This workflow is exposed as the MCP tool "${TOOL_NAME}". ` +
  `Do NOT call the ${TOOL_NAME} tool — you are already inside it. Complete your task directly.]\n\n`;

module.exports = {
  name: WORKFLOW_NAME,
  description:
    "Generates a quiz question by finding an analogy for a user-provided topic, mapping a situation into that analogy space, and formulating a question whose correct answer reveals a truth about the original topic. Uses interactive prompts to gather the topic and deliver the quiz.",
  sourceHash: "82ac7b194b49",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputs: {},
  steps: [
    {
      id: "gather-topic",
      profile: "safe",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        return (
          preamble("gather-topic") +
          `Use the AskUserQuestion tool to ask the user what topic they'd like to be quizzed on.\n\n` +
          `Frame the question in an encouraging, inviting way. Let them know they can pick any subject, concept, or domain — ` +
          `the more specific, the better the quiz will be. Offer a few examples like "how TCP/IP works", "natural selection", or "supply and demand".\n\n` +
          `After the user responds, output their chosen topic exactly as they stated it. Do not embellish or rephrase — just repeat back the topic string they gave you.`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "generate-analogy-question",
    },
    {
      id: "generate-analogy-question",
      profile: "safe",
      type: "agent",
      disallowedTools: [SELF_TOOL, "mcp__integrated__explain_topic"],
      buildPrompt(ctx) {
        const topic = ctx.steps["gather-topic"].output;
        return (
          preamble("generate-analogy-question") +
          `You are a creative quiz designer. Your task is to craft an analogy-based multiple-choice question about the following topic:\n\n` +
          `Topic: "${topic}"\n\n` +
          `Do all of the following work yourself — do NOT delegate to any tool. Think step by step:\n\n` +
          `**Step 1 — Find an analogy.** Identify a surprising, non-obvious analogy from a completely different domain that maps well onto the topic. ` +
          `The analogy should be vivid, concrete, and accessible. Avoid cliché comparisons. ` +
          `For example, if the topic were "TCP/IP networking", a good analogy might be "a postal system in a medieval kingdom".\n\n` +
          `**Step 2 — Map a situation.** Create a specific scenario within the analogy space that parallels an important truth or principle about the original topic. ` +
          `The scenario should be detailed enough to be engaging but focused on one key insight.\n\n` +
          `**Step 3 — Formulate a multiple-choice question.** Write a question set entirely within the analogy world. ` +
          `Do NOT mention the original topic ("${topic}") anywhere in the question text or answer options. ` +
          `Create 4 answer options labeled A, B, C, D where:\n` +
          `- The correct answer, when mapped back to the original topic, reveals a genuine truth or principle\n` +
          `- The wrong answers represent common misconceptions or plausible-but-incorrect beliefs about the original topic\n` +
          `- All options sound reasonable within the analogy framing\n\n` +
          `**Step 4 — Prepare the explanation.** Write a clear explanation that maps the correct answer back to the original topic, ` +
          `revealing what truth it teaches. Also briefly note why each wrong answer corresponds to a misconception about the original topic.\n\n` +
          `Output your result in exactly this format:\n\n` +
          `ANALOGY DOMAIN: [the analogy domain you chose]\n\n` +
          `SCENARIO: [1-2 sentence scene-setting for the analogy world]\n\n` +
          `QUESTION: [the multiple-choice question, set entirely in the analogy world]\n\n` +
          `A) [option A]\n` +
          `B) [option B]\n` +
          `C) [option C]\n` +
          `D) [option D]\n\n` +
          `CORRECT ANSWER: [letter]\n\n` +
          `EXPLANATION: [full explanation mapping the correct answer back to "${topic}", plus notes on why each wrong option is a misconception]`
        );
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
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const quizPackage = ctx.steps["generate-analogy-question"].output;
        return (
          preamble("deliver-quiz") +
          `You are a quiz host presenting an analogy-based quiz question to the user. Below is the complete quiz package with the question, options, correct answer, and explanation.\n\n` +
          `--- QUIZ PACKAGE (for your eyes only — do NOT show the correct answer or explanation yet) ---\n` +
          `${quizPackage}\n` +
          `--- END QUIZ PACKAGE ---\n\n` +
          `Follow these steps exactly:\n\n` +
          `1. First, output 1–2 engaging sentences that set the scene using the analogy scenario. Paint the picture of the analogy world to draw the user in.\n\n` +
          `2. Then use the AskUserQuestion tool to present the multiple-choice question. The question text should include the question itself, and the options should be the four choices (A, B, C, D) with their text. Do NOT reveal the correct answer or any part of the explanation in this step.\n\n` +
          `3. After the user responds, determine whether they chose the correct answer. Then output a response that includes:\n` +
          `   - Whether they were correct or not (celebrate if correct, encourage if wrong)\n` +
          `   - The correct answer letter and text\n` +
          `   - The full explanation mapping the analogy back to the original topic and the truth it reveals\n` +
          `   - Brief notes on why each of the wrong options corresponds to a misconception about the original topic\n\n` +
          `Make the whole interaction feel fun, engaging, and educational. Use a warm, enthusiastic tone.`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: null,
    },
  ],
};
