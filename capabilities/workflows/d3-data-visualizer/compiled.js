// Compiled workflow: d3-data-visualizer
// Source hash: 0c7e1818da9b
// Generated: 2026-03-30
//
// Asks the user what data to analyse, designs the optimal visualization approach,
// then generates a self-contained HTML file using D3.js from CDN with embedded
// HTML, CSS, and JavaScript.

module.exports = {
  name: "d3-data-visualizer",
  sourceHash: "0c7e1818da9b",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  inputs: {},
  steps: [
    {
      id: "gather-requirements",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        return `Use the AskUserQuestion tool to ask the user what data they want to visualize. Ask them to describe:

1. The data source or dataset they want to analyse
2. What kind of insights or story they want the visualization to tell
3. Any preferences for chart type (bar, line, scatter, pie, treemap, force-directed graph, etc.) or if they want you to recommend the best approach

Collect their response and summarize the requirements clearly, covering: the data described, the analytical goals, and their visualization preferences.`;
      },
      parseOutput(raw) {
        return raw;
      },
      next: "design-visualization"
    },
    {
      id: "design-visualization",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const requirements = ctx.steps["gather-requirements"].output;
        return `Here are the user's visualization requirements:

${requirements}

Based on these requirements, design the optimal D3.js visualization approach. Consider:

1. The best chart type for the data and goals described
2. The data structure needed (arrays, nested objects, etc.)
3. Color scheme and layout decisions
4. Any interactivity (tooltips, hover effects, transitions, zoom, filtering)
5. Responsive design considerations

If the user provided raw data, plan how to embed it. If they described a data pattern, plan how to generate representative sample data.

Produce a detailed visualization design specification including chart type, axes, scales, color palette, dimensions, and interactive features.`;
      },
      parseOutput(raw) {
        return raw;
      },
      next: "generate-html"
    },
    {
      id: "generate-html",
      profile: "full",
      type: "agent",
      buildPrompt(ctx) {
        const requirements = ctx.steps["gather-requirements"].output;
        const design = ctx.steps["design-visualization"].output;
        return `User's visualization requirements:

${requirements}

Visualization design specification:

${design}

Generate a single self-contained HTML file that implements the visualization design. The file MUST:

1. Load D3.js from CDN (https://d3js.org/d3.v7.min.js) via a <script> tag
2. Embed ALL CSS in a <style> block in the <head> with a clean, modern design using proper fonts (Google Fonts or system fonts)
3. Embed ALL JavaScript in a <script> block
4. Embed the data directly in JavaScript (no external data files)
5. Be fully responsive
6. Include tooltips or hover interactions where appropriate
7. Include a title and any necessary labels/legends
8. Use smooth transitions and animations for visual polish
9. Have proper margins, padding, and spacing for a production-quality appearance

Write the file to 'visualization.html' in the current working directory. Make sure the visualization is production-quality and visually appealing.

Return the absolute file path of the generated HTML file.`;
      },
      parseOutput(raw) {
        const match = raw.match(/(?:^|\s)(\/[^\s]+\.html)\b/m);
        return match ? match[1].trim() : raw;
      },
      next: "summary",
      maxRetries: 2
    },
    {
      id: "summary",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        const requirements = ctx.steps["gather-requirements"].output;
        const design = ctx.steps["design-visualization"].output;
        const generated = ctx.steps["generate-html"].output;
        return `Context from previous steps:

User requirements:
${requirements}

Visualization design:
${design}

Generation result:
${generated}

Provide a concise summary to the user of what was created. Include:

1. The chart type and why it was chosen
2. Key features of the visualization (interactivity, responsiveness, etc.)
3. The file path where the HTML was saved (./visualization.html)
4. Instructions on how to open it — just open the HTML file in any modern browser, no server needed since D3.js loads from CDN

If sample data was used, mention that they can modify the embedded data array in the JavaScript to update the visualization with their own data.`;
      },
      parseOutput(raw) {
        return raw;
      },
      next: null
    }
  ]
};
