const { execSync } = require("child_process");

const WORKFLOW_NAME = "drawing-tutorial-generator";
const SELF_TOOL = "mcp__integrated__drawing_tutorial_generator";

function preamble(stepId) {
  return (
    `[Workflow context: you are executing step "${stepId}" of the "${WORKFLOW_NAME}" workflow. ` +
    `This workflow is exposed as the MCP tool "${SELF_TOOL}". ` +
    `Do NOT call the ${SELF_TOOL} tool — you are already inside it. Complete your task directly.]\n\n`
  );
}

function extractJSON(raw) {
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) try { return JSON.parse(fence[1].trim()); } catch {}
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) try { return JSON.parse(brace[0]); } catch {}
  return null;
}

function grayElement(el) {
  let g = el
    .replace(/stroke="[^"]*"/g, 'stroke="#CCCCCC"')
    .replace(/stroke-width="[^"]*"/g, 'stroke-width="0.5"')
    .replace(/fill="[^"]*"/g, 'fill="none"')
    .replace(/\s*stroke-linecap="[^"]*"/g, "")
    .replace(/opacity="[^"]*"/g, "");
  g = g.replace(/\s*\/>/, ' opacity="0.4"/>');
  return g.replace(/\s{2,}/g, " ");
}

module.exports = {
  name: WORKFLOW_NAME,
  description:
    "Analyze a drawing image and generate a step-by-step SVG drawing tutorial with localized student instructions, construction lines, and precise SVG element data",
  sourceHash: "1983d5dd3e30",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  inputs: {
    image_path: {
      type: "file",
      description:
        "Absolute path to the drawing image file to analyze. If omitted, the workflow will ask the user to provide one.",
      accept: "image/*",
      required: false,
    },
    language: {
      type: "string",
      description:
        "Language for tutorial text (title, pedagogy_principle, student_script). Use the full language name, e.g. Deutsch, English, Français.",
      required: false,
      default: "Deutsch",
    },
  },
  outputs: {
    tutorial: {
      type: "json",
      description:
        "Complete tutorial JSON with analysis, all steps, accumulated SVG elements, and localized instructions. Includes exact 'canvas_width' (always 1000), 'canvas_height', and 'source_dimensions' fields derived from ImageMagick measurement, replacing the previous LLM-guessed 'canvas_aspect_ratio'.",
      from_step: "generate-tutorial",
    },
  },
  steps: [
    // ── Step 1: resolve-image ────────────────────────────────────────────
    {
      id: "resolve-image",
      profile: "full",
      type: "agent",
      resolveSync(ctx) {
        const p = (ctx.inputs.image_path || "").trim();
        return p && p.startsWith("/") ? p : null;
      },
      buildPrompt(ctx) {
        return (
          preamble("resolve-image") +
          `No image file path was provided by the user. You need to ask them for one.

Use the AskUserQuestion tool to ask the user to provide the image file. Configure it as follows:
- type: "file"
- question: "Please provide the drawing image file you want to analyze"
- accept: "image/*"

Once the user provides the file path, use the Read tool to read it and confirm it is a valid image.

After verifying, output ONLY the absolute file path as plain text. Nothing else — no commentary, no formatting, just the path.`
        );
      },
      parseOutput(raw) {
        const lines = raw.trim().split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith("/") && !line.includes(" ")) return line;
        }
        return lines[lines.length - 1]?.trim() || raw.trim();
      },
      allowedTools: ["Read", "AskUserQuestion"],
      disallowedTools: [SELF_TOOL],
      next: "get-image-dimensions",
    },

    // ── Step 2: get-image-dimensions ─────────────────────────────────────
    {
      id: "get-image-dimensions",
      profile: null,
      type: "agent",
      resolveSync(ctx) {
        const imagePath = ctx.steps["resolve-image"]?.output;
        if (!imagePath) return null;
        try {
          const safe = imagePath.replace(/'/g, "'\\''");
          const out = execSync(`identify -format '%w %h' '${safe}'`, {
            encoding: "utf8",
            timeout: 10000,
          }).trim();
          const nums = out.replace(/['"]/g, "").split(/\s+/).map(Number);
          const [width, height] = nums;
          if (!width || !height || width <= 0 || height <= 0) return null;
          return { width, height, canvasHeight: Math.round((1000 * height) / width) };
        } catch {
          return null;
        }
      },
      buildPrompt() {
        return "";
      },
      parseOutput(raw) {
        return raw;
      },
      allowedTools: [],
      disallowedTools: [SELF_TOOL],
      next: "generate-tutorial",
    },

    // ── Step 3: generate-tutorial ────────────────────────────────────────
    {
      id: "generate-tutorial",
      profile: "full",
      type: "agent",
      buildPrompt(ctx) {
        const imagePath = ctx.steps["resolve-image"]?.output || "";
        const dims = ctx.steps["get-image-dimensions"]?.output || {};
        const language = (ctx.inputs.language || "").trim() || "Deutsch";
        const { width = 0, height = 0, canvasHeight = 0 } = dims;

        return (
          preamble("generate-tutorial") +
          `You are an expert drawing instructor. Your task is to analyze an image and produce a structured JSON tutorial with precise SVG drawing elements.

Use the Read tool to read the image file at: ${imagePath}
Study the image carefully — you need precise coordinates for every SVG element you produce.

**Tutorial language:** ${language}
**Source image dimensions:** ${width} x ${height} pixels
**Canvas:** viewBox="0 0 1000 ${canvasHeight}" (width is always 1000; height ${canvasHeight} was computed as Math.round(1000 * ${height} / ${width}))

---

## PHASE 1 — INTERNAL ANALYSIS (do not output)

Before generating anything, analyze the image thoroughly in your head:
- Identify the subject and classify it (portrait | figure | animal | object | architecture | landscape | botanical | vehicle | abstract).
- Choose a construction method (loomis | gesture_mannequin | skeleton_volumes | primitive_decomposition | perspective_grid | envelope_depth | centerline_silhouette).
- Map at least 10–15 key landmarks with precise x/y percentage coordinates measured against the actual image.
- Note symmetry axes, perspective type, vanishing points, and key proportions.
- Assess complexity on a 1–10 scale.

## PHASE 2 — STEP DESIGN (do not output)

Design tutorial steps following this pedagogy sequence:

1. **SCAFFOLDING** — bounding shape, axis lines, proportion tick marks. Student places the drawing and gets the scale right.
2. **PRIMARY VOLUMES** — big geometric shapes (ellipses, rectangles, cylinders) capturing major masses.
3. **STRUCTURAL CONNECTIONS** — how volumes connect: joint lines, contour envelope, flow lines.
4. **PRIMARY CONTOUR** — outer silhouette refined from geometric to organic/accurate.
5. **SECONDARY FEATURES** — major interior elements (eyes/nose/mouth for faces, windows/doors for buildings, major markings for animals).
6. **DETAIL REFINEMENT** — smaller interior details, surface features, texture indications. Only if warranted.
7. **SHADING / VALUES** — light direction, core shadows, cast shadows as shape regions. Only if the source image contains shading.

Step-count rules:
- Use as many steps as the subject needs — no artificial cap.
- Simple subjects (apple, cup) might need 3 steps; complex subjects (portrait, street scene) might need 6–8.
- Each step adds exactly ONE cognitive task. If you are adding two unrelated things, split them.
- Never combine "place the feature" and "detail the feature" in one step.

## PHASE 3 — PRODUCE THE JSON

Output a SINGLE JSON object inside a \`\`\`json code fence. No text before or after the fence.

Structure:

\`\`\`json
{
  "file": "${imagePath}",
  "language": "${language}",
  "canvas_width": 1000,
  "canvas_height": ${canvasHeight},
  "source_dimensions": "${width}x${height}",
  "tutorial": [
    {
      "step_number": 1,
      "title": "...",
      "pedagogy_principle": "...",
      "student_script": "...",
      "svg_elements": [ "..." ]
    }
  ]
}
\`\`\`

### Field rules

- **file**: exactly \`${imagePath}\`
- **canvas_width**: always 1000
- **canvas_height**: exactly ${canvasHeight} — do NOT guess or override
- **source_dimensions**: exactly "${width}x${height}"
- **step_number**: sequential starting at 1
- **title**, **pedagogy_principle**, **student_script**: written entirely in **${language}**

### Student script rules

- Write entirely in ${language}, using informal second-person address ("du" in German, "you" in English, "tu" in French).
- Explain what to draw, in what order, and why.
- Reference proportions concretely (e.g. "Die Augen sitzen auf der horizontalen Mittellinie" in German).
- Refer to all drawn lines as light pencil strokes — never mention colors.
- End each script with a self-check question the student should verify before continuing.
- Step 1 MUST begin with the equivalent of: "You will need: HB pencil, eraser, smooth drawing paper." — written naturally in ${language}.

### SVG elements — DELTA MODEL

CRITICAL: Each step's \`svg_elements\` contains ONLY the NEW elements introduced in that step. Do NOT repeat elements from earlier steps. Prior-step graying is handled automatically by post-processing.

Canvas coordinate system: viewBox="0 0 1000 ${canvasHeight}". White background.

**Construction lines** (helper guides for the current step):
- \`stroke="#CC0000" stroke-width="0.8" fill="none"\`
- Example: \`<ellipse cx="500" cy="320" rx="180" ry="230" stroke="#CC0000" stroke-width="0.8" fill="none"/>\`
- Example: \`<line x1="500" y1="90" x2="500" y2="550" stroke="#CC0000" stroke-width="0.8" fill="none"/>\`

**Contour lines** (final drawing lines for the current step):
- \`stroke="#000000" stroke-width="1.2" fill="none" stroke-linecap="round"\`
- Example: \`<path d="M 320,400 C 350,450 400,480 500,490" stroke="#000000" stroke-width="1.2" fill="none" stroke-linecap="round"/>\`

### Coordinate rules

1. Every coordinate is a real number derived from landmark analysis, scaled to the 1000-wide canvas: x = x_pct × 10, y = y_pct × (${canvasHeight} / 100).
2. Every element must have exact numeric coordinates — no vague descriptions.
3. Construction elements must geometrically align with contour elements that refine them in later steps.
4. All elements are self-closing XML tags ending with \`/>\`.
5. Do NOT include \`<svg>\`, \`<rect>\` for background, or \`<text>\` elements.

### Final self-check before outputting

- Coordinates are consistent between construction shapes and the contours refining them later.
- Each step's svg_elements contains ONLY that step's new elements.
- canvas_width is 1000 and canvas_height is exactly ${canvasHeight}.
- Step numbers are sequential.
- All title, pedagogy_principle, and student_script fields are in ${language}.

Output ONLY the JSON inside a \`\`\`json code fence. No commentary before or after.`
        );
      },
      parseOutput(raw) {
        const data = extractJSON(raw);
        if (data?.tutorial && Array.isArray(data.tutorial)) {
          const accumulated = [];
          for (const step of data.tutorial) {
            const newElements = step.svg_elements || [];
            // Prepend grayed prior elements, then current step's originals
            step.svg_elements = [...accumulated, ...newElements];
            // Add grayed copies of this step's elements to the accumulator
            for (const el of newElements) {
              accumulated.push(grayElement(el));
            }
          }
        }
        return data;
      },
      allowedTools: ["Read"],
      disallowedTools: [SELF_TOOL],
      next: null,
    },
  ],

  result(ctx) {
    const output = ctx.steps["generate-tutorial"]?.output;
    if (!output) return null;
    if (typeof output === "string") {
      try {
        return { tutorial: JSON.parse(output) };
      } catch {
        return { tutorial: output };
      }
    }
    return { tutorial: output };
  },
};
