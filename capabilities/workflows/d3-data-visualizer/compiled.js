// Compiled workflow: d3-data-visualizer
// Source hash: f7a1d861d108
// Generated: 2026-03-30
//
// Asks the user what data to analyse, designs the optimal visualization approach,
// then generates a self-contained HTML file using D3.js from CDN with embedded
// HTML, CSS, and JavaScript.

module.exports = {
  name: "d3-data-visualizer",
  sourceHash: "f7a1d861d108",
  inputs: {},
  steps: [
    {
      id: "gather-requirements",
      profile: "safe",
      type: "agent",
      buildPrompt(ctx) {
        return `Use the AskUserQuestion tool to ask the user what data they want to visualize. Ask them to describe:

1. The data they want to analyse — they can paste raw data, describe a dataset, or point to a file
2. Any preferences for chart type (bar, line, scatter, pie, heatmap, etc.) or say 'auto' for automatic selection
3. Any specific styling or interactivity requirements

Collect their responses and summarize the requirements clearly as a structured summary covering: the data, the preferred visualization type, and any styling/interactivity requirements.`;
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

Based on these requirements, design the optimal visualization approach. Analyse the data characteristics (categorical vs numerical, time-series, distribution, comparison, correlation, etc.) and determine:

1. The best D3.js chart type if the user chose 'auto', or validate their chosen type against the data
2. The layout and dimensions
3. Axes, scales, color schemes, and legends needed
4. Any interactive features (tooltips, hover effects, transitions, zoom/pan)
5. Responsive design considerations

Produce a detailed visualization design specification including chart type, scales, axes, color scheme, interactivity plan, and data transformation strategy.`;
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

Generate a single self-contained HTML file that implements the designed visualization. The file must:

1. Load D3.js from CDN (https://d3js.org/d3.v7.min.js) via a script tag
2. Embed all CSS in a <style> block with a clean, modern design including proper fonts, colors, and layout
3. Embed all JavaScript in a <script> block that creates the D3.js visualization
4. Include the data directly embedded in the JavaScript
5. Be responsive and work well in modern browsers
6. Include interactive features like tooltips on hover, smooth transitions, and proper axis labels with formatting

Write the file to the current working directory with a descriptive filename ending in .html. Make sure the visualization is polished and production-quality with proper margins, padding, titles, and legends where appropriate.

Return the absolute file path of the generated self-contained HTML file.`;
      },
      parseOutput(raw) {
        return raw;
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

Present a clear summary to the user including:

1. What visualization was created and why that chart type was chosen
2. The file path where the HTML file was saved
3. How to open it (e.g., open in a browser)
4. A brief description of the interactive features included

Ask if they would like any adjustments to the visualization.`;
      },
      parseOutput(raw) {
        return raw;
      },
      next: null
    }
  ]
};
