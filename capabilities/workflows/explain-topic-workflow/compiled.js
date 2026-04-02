module.exports = {
  name: "explain-topic-workflow",
  sourceHash: "f68b47ebd7a6",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputs: {
    topic: { type: "string", required: true, description: "The topic the user wants explained" }
  },
  steps: [
    {
      id: "choose-analogy",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        return `Given the topic '${ctx.inputs.topic}', think of a vivid, everyday analogy that makes the core concepts intuitive. Output the analogy name and a one-sentence summary of why it fits.

Your output should clearly state:
1. **Analogy name** — a short, memorable label
2. **Why it fits** — one sentence explaining why this analogy maps well to the topic`;
      },
      parseOutput(raw) {
        const nameMatch = raw.match(/\*\*Analogy(?:\s+name)?\*\*[:\s—-]*(.+?)(?:\n|$)/i)
          || raw.match(/Analogy(?:\s+name)?[:\s—-]*(.+?)(?:\n|$)/i);
        const justificationMatch = raw.match(/\*\*Why[^*]*\*\*[:\s—-]*(.+?)(?:\n|$)/i)
          || raw.match(/Why it fits[:\s—-]*(.+?)(?:\n|$)/i);
        return {
          analogyName: nameMatch ? nameMatch[1].trim() : raw.split('\n')[0].trim(),
          justification: justificationMatch ? justificationMatch[1].trim() : raw,
          description: raw
        };
      },
      next: "explain-with-analogy",
      maxRetries: 2
    },
    {
      id: "explain-with-analogy",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const analogy = ctx.steps["choose-analogy"].output;
        return `Using the chosen analogy, write a clear, engaging explanation of '${ctx.inputs.topic}'. Map each key concept of the topic to a concrete element in the analogy. Keep it conversational and accessible to someone with no prior knowledge. End with a short recap of the key takeaways.

CHOSEN ANALOGY:
${analogy.description}

Format your explanation with:
- A compelling opening that introduces the analogy
- Clear **concept → analogy element** mappings (use a table or bold pairs)
- Conversational, jargon-free language
- A **Key Takeaways** section at the end summarizing the main points`;
      },
      parseOutput(raw) {
        return {
          explanation: raw,
          description: raw
        };
      },
      next: "gather-questions",
      maxRetries: 2
    },
    {
      id: "gather-questions",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const explanation = ctx.steps["explain-with-analogy"].output;
        return `Present the following explanation to the user, then ask for their follow-up questions.

EXPLANATION TO PRESENT:
${explanation.explanation}

After presenting the explanation, use the AskUserQuestion tool to ask:
'What questions do you have about this topic? (Type "none" if everything is clear.)'`;
      },
      parseOutput(raw) {
        const lower = raw.toLowerCase().trim();
        const hasQuestions = !(lower === "none" || lower.includes("no questions")
          || lower.includes("everything is clear") || lower.includes("all clear")
          || lower.includes("nothing") || /^none\.?$/m.test(lower));
        return {
          userResponse: raw,
          hasQuestions: hasQuestions,
          description: raw
        };
      },
      next: "answer-questions",
      maxRetries: 2
    },
    {
      id: "answer-questions",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const analogy = ctx.steps["choose-analogy"].output;
        const explanation = ctx.steps["explain-with-analogy"].output;
        const questions = ctx.steps["gather-questions"].output;
        return `If the user provided follow-up questions, answer each one clearly, continuing to reference the analogy where helpful. If the user said 'none' or indicated no questions, simply acknowledge that everything is clear and move on.

ANALOGY USED:
${analogy.description}

EXPLANATION PROVIDED:
${explanation.explanation}

USER'S RESPONSE:
${questions.userResponse}

If there are questions, answer each one with:
- A clear, direct answer
- A reference back to the analogy where it helps clarify
- Conversational, accessible language`;
      },
      parseOutput(raw) {
        return {
          answers: raw,
          description: raw
        };
      },
      evaluate(ctx) {
        const questions = ctx.steps["gather-questions"].output;
        return questions.hasQuestions === true;
      },
      then: "summary",
      else: "summary",
      maxRetries: 2
    },
    {
      id: "summary",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const analogy = ctx.steps["choose-analogy"].output;
        const explanation = ctx.steps["explain-with-analogy"].output;
        const questions = ctx.steps["gather-questions"].output;
        const answers = ctx.steps["answer-questions"].output;
        return `Write a brief summary that recaps the entire explanation session. Format it as a clean, readable reference the user can keep.

CONTEXT:
- Topic: ${ctx.inputs.topic}
- Analogy used: ${analogy.description}
- Explanation: ${explanation.explanation}
- User's questions: ${questions.userResponse}
- Answers provided: ${answers ? answers.answers : "No follow-up questions were asked."}

Structure the summary as:

## Topic Reference: ${ctx.inputs.topic}

### Analogy
The analogy name and why it was chosen.

### Key Concept Mappings
A concise table or list mapping topic concepts to analogy elements.

### Follow-Up Q&A
Any questions that were asked and their answers (or note that none were asked).

### Key Takeaways
The most important points to remember.

Keep it concise and scannable — this is a reference document, not a full explanation.`;
      },
      parseOutput(raw) {
        return {
          summary: raw,
          description: raw
        };
      },
      next: null,
      maxRetries: 1
    }
  ]
};
