const WORKFLOW_NAME = "d3-data-visualizer";
const TOOL_NAME = "d3_data_visualizer";
const SELF_TOOL = "mcp__integrated__d3_data_visualizer";

const preamble = (stepId) =>
  `[Workflow context: you are executing step "${stepId}" of the "${WORKFLOW_NAME}" workflow. ` +
  `This workflow is exposed as the MCP tool "${TOOL_NAME}". ` +
  `Do NOT call the ${TOOL_NAME} tool — you are already inside it. Complete your task directly.]\n\n`;

module.exports = {
  name: WORKFLOW_NAME,
  description:
    "Asks the user what data to analyse, designs the optimal visualization approach, then generates a self-contained HTML file using D3.js from CDN with embedded HTML, CSS, and JavaScript.",
  sourceHash: "2fafe3d3fbd5",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  inputs: {},
  steps: [
    {
      id: "gather-requirements",
      profile: "safe",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        return (
          preamble("gather-requirements") +
          `You are a data visualization consultant gathering requirements from a user. ` +
          `Use the AskUserQuestion tool to ask the user the following:\n\n` +
          `"What data would you like to visualize? Please describe:\n` +
          `- The data itself (or point me to a file path or URL)\n` +
          `- What insights or story you want the visualization to convey\n` +
          `- Any preferences for chart type or visual style"\n\n` +
          `After the user responds, do the following:\n\n` +
          `1. If the user referenced a file, use the Read tool to read it. Examine its structure: column names, data types, number of rows, and value ranges.\n` +
          `2. If the user referenced a URL, use the WebFetch tool to retrieve and examine the data.\n` +
          `3. If the user described data inline, parse and summarize its characteristics.\n\n` +
          `Then output a structured summary with these sections:\n\n` +
          `**Data Characteristics:**\n` +
          `- Structure (columns/fields and their types)\n` +
          `- Size (row/record count)\n` +
          `- Value ranges and distributions for key fields\n` +
          `- Sample values (first 3-5 rows or records)\n\n` +
          `**User Goals:**\n` +
          `- What insights or story they want to convey\n` +
          `- Any stated preferences for chart type or style\n\n` +
          `If the data is ambiguous or the user's description is unclear, use the AskUserQuestion tool to ask a follow-up question before producing your summary.`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "design-visualization",
    },
    {
      id: "design-visualization",
      profile: "safe",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const requirements = ctx.steps["gather-requirements"].output;
        return (
          preamble("design-visualization") +
          `You are a data visualization architect. Based on the data requirements below, design the optimal D3.js visualization approach. ` +
          `Do all design work yourself — do NOT delegate to any tool.\n\n` +
          `--- DATA REQUIREMENTS ---\n${requirements}\n--- END REQUIREMENTS ---\n\n` +
          `Analyze the data types (categorical, temporal, numerical, hierarchical, network) and produce a detailed visualization design specification with these sections:\n\n` +
          `**1. Chart Type & Rationale:**\n` +
          `Choose the most effective chart type (bar, grouped bar, stacked bar, line, multi-line, scatter, area, stacked area, pie/donut, treemap, force-directed graph, heatmap, choropleth, etc.) and explain why it's the best fit for this data and the user's goals.\n\n` +
          `**2. Data-to-Visual Mappings:**\n` +
          `Specify which data fields map to which visual encodings: x-axis, y-axis, color, size, opacity, shape, labels, grouping, etc.\n\n` +
          `**3. Data Transformations:**\n` +
          `List any transformations needed before rendering: aggregation, filtering, sorting, nesting, date parsing, normalization, etc. Write pseudocode for non-trivial transformations.\n\n` +
          `**4. Interactive Features:**\n` +
          `Specify interactivity: tooltips (what data to show on hover), hover effects (highlight, dim others), zoom/pan, transitions/animations, click behaviors, brush selection, etc.\n\n` +
          `**5. Color Scheme & Styling:**\n` +
          `Specify the color palette (name a D3 color scheme like d3.schemeCategory10, d3.interpolateBlues, etc.), font choices, background, spacing, and overall visual style.\n\n` +
          `**6. Layout:**\n` +
          `Specify dimensions (width, height), margins, axis label positions, legend placement, title placement, and responsive behavior.\n\n` +
          `If anything about the data or goals is ambiguous and you need clarification, use the AskUserQuestion tool to ask the user before finalizing your design.`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "generate-html",
    },
    {
      id: "generate-html",
      profile: "full",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const requirements = ctx.steps["gather-requirements"].output;
        const design = ctx.steps["design-visualization"].output;
        return (
          preamble("generate-html") +
          `You are a D3.js developer. Your task is to implement a data visualization as a single self-contained HTML file. ` +
          `Write the code yourself — do NOT delegate to any tool except the Write tool to save the file.\n\n` +
          `--- DATA REQUIREMENTS ---\n${requirements}\n--- END REQUIREMENTS ---\n\n` +
          `--- VISUALIZATION DESIGN ---\n${design}\n--- END DESIGN ---\n\n` +
          `If the data requirements reference a file path, use the Read tool to read the actual data from that file first.\n\n` +
          `Create a single self-contained HTML file that meets ALL of these requirements:\n\n` +
          `1. **D3.js from CDN**: Load D3.js v7 via \`<script src="https://d3js.org/d3.v7.min.js"></script>\`\n` +
          `2. **Embedded CSS**: All styles in a \`<style>\` block — use a clean, modern design with proper fonts (system font stack or Google Fonts via CDN), good spacing, and a polished look\n` +
          `3. **Embedded JavaScript**: All code in a \`<script>\` block\n` +
          `4. **Embedded data**: The data must be embedded directly in the JavaScript as a JSON array or appropriate data structure — do NOT reference any external data files\n` +
          `5. **Interactivity**: Implement the interactive features from the design spec (tooltips, hover effects, transitions, etc.)\n` +
          `6. **Labels and legend**: Include a descriptive title, properly labeled axes, and a legend where appropriate\n` +
          `7. **Responsive**: The visualization should look good at common screen widths (use viewBox or resize handlers)\n` +
          `8. **Clean HTML structure**: Proper DOCTYPE, charset meta tag, viewport meta tag\n\n` +
          `Use the Write tool to save the file to the current working directory with a descriptive filename like \`visualization.html\` or a name that reflects the data (e.g., \`sales-trends.html\`).\n\n` +
          `After writing the file, output ONLY the absolute file path of the generated HTML file.`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "summary",
    },
    {
      id: "summary",
      profile: "safe",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const requirements = ctx.steps["gather-requirements"].output;
        const design = ctx.steps["design-visualization"].output;
        const filePath = ctx.steps["generate-html"].output;
        return (
          preamble("summary") +
          `You are summarizing a completed data visualization for the user. Write a concise, friendly summary directly — do NOT delegate to any tool.\n\n` +
          `--- DATA REQUIREMENTS ---\n${requirements}\n--- END REQUIREMENTS ---\n\n` +
          `--- VISUALIZATION DESIGN ---\n${design}\n--- END DESIGN ---\n\n` +
          `--- GENERATED FILE ---\n${filePath}\n--- END FILE ---\n\n` +
          `Write a summary that covers:\n\n` +
          `1. **What was visualized**: Brief description of the data\n` +
          `2. **Chart type chosen**: Name the chart type and give a one-sentence reason why it was selected\n` +
          `3. **Key interactive features**: List the interactive elements included (tooltips, hover effects, transitions, etc.)\n` +
          `4. **File location**: State the file path clearly\n` +
          `5. **How to view it**: Tell the user to open the file in a web browser (e.g., "Open the file in your browser" or provide a command like \`open visualization.html\` or \`xdg-open visualization.html\`)\n\n` +
          `End with 1-2 brief suggestions for potential improvements or extensions (e.g., adding filters, animation, additional data dimensions, or exporting as SVG/PNG).`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: null,
    },
  ],
};
