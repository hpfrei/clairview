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
  sourceHash: "07b34035bb06",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  inputs: {
    data_description: {
      type: "string",
      description:
        "Description of the data to visualize and/or the desired chart type. If empty, the user will be asked interactively.",
      required: false,
    },
  },
  steps: [
    {
      id: "gather-and-design",
      profile: "full",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const dataDesc = ctx.inputs.data_description || "";
        const gatherBlock = dataDesc
          ? `The user has described the data they want to visualize:\n"${dataDesc}"\n\nUse this as your data description. Do not ask for further input — proceed directly to the design phase below.`
          : `No data description was provided. Use the AskUserQuestion tool to ask the user what data they want to visualize. ` +
            `Frame it as a friendly, specific request. Ask them to describe:\n` +
            `- The data itself (they can paste raw data, describe a dataset, or specify a concept)\n` +
            `- What insight or story they want the visualization to tell\n` +
            `- Any chart type preferences (optional)\n\n` +
            `Offer concrete examples to guide them, such as:\n` +
            `- "Monthly sales figures by region as a grouped bar chart"\n` +
            `- "Network of software dependencies as a force-directed graph"\n` +
            `- "Temperature changes over 50 years as a line chart with trend"\n` +
            `- "Budget breakdown as a donut chart"\n\n` +
            `After the user responds, use their answer as the data description for the design phase below.`;

        return (
          preamble("gather-and-design") +
          `You are a data visualization architect specializing in D3.js. Your task is to gather data requirements and produce a detailed visualization design specification.\n\n` +
          `**Phase 1 — Gather data requirements**\n\n` +
          `${gatherBlock}\n\n` +
          `**Phase 2 — Design the visualization**\n\n` +
          `Based on the data description, work through each of these design decisions yourself. Do NOT delegate this work to any tool.\n\n` +
          `1. **Chart type selection**: Choose the optimal D3.js chart type from: bar, grouped bar, stacked bar, line, multi-line, area, scatter, bubble, pie, donut, treemap, sunburst, force-directed graph, chord diagram, sankey, heatmap, histogram, box plot, or another appropriate type. Write 1-2 sentences justifying why this type best serves the data and the user's insight goal.\n\n` +
          `2. **Data structure**: Define the exact JavaScript data structure. If the user provided raw data, parse and validate it into a clean JavaScript representation. If they described data conceptually, generate realistic, detailed sample data (at least 8-15 data points) that will make the visualization look compelling and demonstrate its features well. Output the data as a JavaScript const assignment (e.g., \`const data = [...];\`).\n\n` +
          `3. **Visual encodings**: Specify exactly what maps to:\n` +
          `   - x-axis (scale type: linear, band, time, etc.)\n` +
          `   - y-axis (scale type and domain)\n` +
          `   - Color (categorical scheme like d3.schemeTableau10, sequential, diverging, or custom hex values)\n` +
          `   - Size (if applicable, e.g., bubble charts)\n` +
          `   - Labels and tooltip content\n\n` +
          `4. **Layout and styling**:\n` +
          `   - SVG dimensions (width, height) and margin convention values (top, right, bottom, left)\n` +
          `   - Whether the chart should be responsive (viewBox-based)\n` +
          `   - Font: system font stack \`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif\`\n` +
          `   - Background: white or very light (#fafafa)\n` +
          `   - Grid lines: subtle, light gray where appropriate\n` +
          `   - Color palette: specify exact colors or D3 scheme name\n\n` +
          `5. **Interactivity plan**:\n` +
          `   - Tooltip behavior (div-based tooltip, not SVG title): what content to show, positioning\n` +
          `   - Hover effects: opacity changes, highlights, stroke changes\n` +
          `   - Transitions: entrance animations, duration in ms\n` +
          `   - Any click behaviors, zoom/pan, or filtering (only if appropriate for the chart type)\n\n` +
          `**Output format**: Write out the complete design specification with all five sections above clearly labeled. Include the actual data values in the data structure section — this will be passed to the next step to generate the HTML file.`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: "generate-visualization",
    },
    {
      id: "generate-visualization",
      profile: "full",
      type: "agent",
      disallowedTools: [SELF_TOOL],
      buildPrompt(ctx) {
        const designSpec = ctx.steps["gather-and-design"].output;
        return (
          preamble("generate-visualization") +
          `You are a senior front-end developer who specializes in D3.js v7 data visualizations. Your task is to implement a visualization based on the design specification below, writing a complete self-contained HTML file.\n\n` +
          `--- DESIGN SPECIFICATION ---\n${designSpec}\n--- END DESIGN SPECIFICATION ---\n\n` +
          `**Step 1 — Write the HTML file**\n\n` +
          `Use the Write tool to create a file at \`/tmp/d3-visualization.html\` with the following structure:\n\n` +
          `- \`<!DOCTYPE html>\` declaration and \`<html lang="en">\`\n` +
          `- \`<head>\` containing:\n` +
          `  - Meta charset UTF-8 and viewport meta tag\n` +
          `  - A \`<title>\` matching the visualization subject\n` +
          `  - A \`<style>\` block with ALL CSS (no external stylesheets). Include:\n` +
          `    - System font stack on body\n` +
          `    - White or very light background (#fafafa or #fff)\n` +
          `    - Centered layout (flexbox or margin auto)\n` +
          `    - Tooltip styling: position absolute, background white, border, border-radius, padding, box-shadow, pointer-events none, opacity 0 by default\n` +
          `    - Any chart-specific styles (axis lines, grid lines, hover effects via CSS transitions)\n` +
          `- \`<body>\` containing:\n` +
          `  - An HTML heading (h1) as the chart title, and a subtitle (h2 or p) if appropriate\n` +
          `  - A container div for the chart (e.g., \`<div id="chart"></div>\`)\n` +
          `  - A tooltip div (e.g., \`<div id="tooltip"></div>\`)\n` +
          `  - A \`<script src="https://d3js.org/d3.v7.min.js"></script>\` tag to load D3 from CDN\n` +
          `  - A \`<script>\` block containing ALL JavaScript:\n` +
          `    - Data defined as a \`const\` at the top (embedded directly from the design spec)\n` +
          `    - D3 margin convention: \`const margin = {top, right, bottom, left}\`, width, height calculations\n` +
          `    - SVG creation appended to the chart container with viewBox for responsiveness\n` +
          `    - Scales, axes, grid lines as specified in the design\n` +
          `    - The main chart rendering (bindings, enter/update patterns, shapes)\n` +
          `    - Axis labels and legend where the design calls for them\n` +
          `    - Tooltip interactivity: mouseover/mousemove/mouseout event handlers that position and populate the tooltip div\n` +
          `    - Entrance transitions (e.g., bars growing from zero, lines drawing in) with appropriate duration\n` +
          `    - Any additional interactivity from the design spec\n\n` +
          `**Requirements**:\n` +
          `- The file must be completely self-contained — zero external dependencies except the D3.js CDN script\n` +
          `- All CSS must be in the \`<style>\` block, all JS in the \`<script>\` block\n` +
          `- Use clean, well-structured, readable JavaScript with proper variable naming\n` +
          `- Ensure no JavaScript syntax errors — the file must open in a browser and render immediately\n\n` +
          `**Step 2 — Verify the file**\n\n` +
          `Use the Read tool to read back \`/tmp/d3-visualization.html\` and confirm:\n` +
          `- It is valid HTML (proper doctype, head, body structure)\n` +
          `- The D3.js CDN script tag is present\n` +
          `- The JavaScript block has no obvious syntax errors (balanced braces, no undefined references)\n` +
          `- The data is embedded correctly\n\n` +
          `If you find any issues, use the Edit tool to fix them.\n\n` +
          `**Step 3 — Present the result**\n\n` +
          `Tell the user:\n` +
          `- The file has been written to \`/tmp/d3-visualization.html\`\n` +
          `- What chart type was generated and a brief summary of what it shows\n` +
          `- They can open it directly in a browser: \`xdg-open /tmp/d3-visualization.html\` (Linux) or \`open /tmp/d3-visualization.html\` (macOS)\n` +
          `- Alternatively, they can serve it with \`cd /tmp && python3 -m http.server 8000\` and visit http://localhost:8000/d3-visualization.html`
        );
      },
      parseOutput(raw) {
        return raw.trim();
      },
      next: null,
    },
  ],
};
