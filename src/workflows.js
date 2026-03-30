// ============================================================
// Workflow Engine — CRUD + runtime for multi-step workflows
// Each step spawns a full claude -p session via ClaudeSessionManager
// ============================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const caps = require('./capabilities');
const { setQuestionContext, clearQuestionContext } = require('./proxy');

const WORKFLOWS_DIR = 'capabilities/workflows';

// ============================================================
// CRUD
// ============================================================

function workflowsDir(cwd) {
  return path.join(cwd || process.cwd(), WORKFLOWS_DIR);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listWorkflows(cwd) {
  const dir = workflowsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const workflows = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wfDir = path.join(dir, entry.name);
    const srcPath = path.join(wfDir, 'workflow.json');
    if (!fs.existsSync(srcPath)) continue;

    try {
      const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
      const compiledPath = path.join(wfDir, 'compiled.js');
      const hasCompiled = fs.existsSync(compiledPath);

      let status = 'draft';
      if (hasCompiled) {
        // Check if source has changed since compilation (normalize via re-serialize to match compile hash)
        const sourceHash = hashContent(JSON.stringify(src, null, 2));
        try {
          const compiled = require(compiledPath);
          status = compiled.sourceHash === sourceHash ? 'compiled' : 'needs-compile';
          delete require.cache[require.resolve(compiledPath)];
        } catch {
          status = 'needs-compile';
        }
      }

      workflows.push({
        name: entry.name,
        description: src.description || '',
        status,
        stepCount: src.steps ? Object.keys(src.steps).length : 0,
      });
    } catch {}
  }

  return workflows;
}

function loadWorkflow(cwd, name) {
  const srcPath = path.join(workflowsDir(cwd), name, 'workflow.json');
  if (!fs.existsSync(srcPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  } catch { return null; }
}

function loadCompiledSource(cwd, name) {
  const p = path.join(workflowsDir(cwd), name, 'compiled.js');
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function saveWorkflow(cwd, name, workflow) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
  const dir = path.join(workflowsDir(cwd), name);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify(workflow, null, 2));
  return true;
}

function saveCompiledSource(cwd, name, source) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
  const dir = path.join(workflowsDir(cwd), name);
  if (!fs.existsSync(dir)) return false;
  fs.writeFileSync(path.join(dir, 'compiled.js'), source);
  return true;
}

function deleteWorkflow(cwd, name) {
  const dir = path.join(workflowsDir(cwd), name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// ============================================================
// RUNTIME — Step execution with parallel, timeout, error handling
// ============================================================

// Active runs: runId → { status, name, steps, ctx, cancel }
const activeRuns = new Map();

function generateRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Run a workflow. Each agent step spawns a full claude -p session.
 */
async function runWorkflow(name, inputs, { sessionManager, broadcaster, cwd, tabId, proxyPort }) {
  const workflow = loadWorkflow(cwd, name);
  if (!workflow) throw new Error(`Workflow not found: ${name}`);

  const runId = generateRunId();
  const stepEntries = Object.entries(workflow.steps || {});
  if (stepEntries.length === 0) throw new Error('Workflow has no steps');

  // Build context
  const ctx = {
    inputs: { ...(workflow.inputs || {}), ...inputs },
    steps: {},
  };

  // Resolve input template values
  for (const [key, desc] of Object.entries(workflow.inputs || {})) {
    if (!ctx.inputs[key] || ctx.inputs[key] === desc) {
      ctx.inputs[key] = inputs[key] || '';
    }
  }

  const run = {
    runId,
    name,
    tabId: tabId || null,
    status: 'running',
    steps: stepEntries.map(([id, step]) => ({ id, ...step, status: 'pending', output: null, elapsed: null })),
    ctx,
    cancel: false,
    currentProc: null,
    startedAt: Date.now(),
  };
  activeRuns.set(runId, run);

  broadcaster.broadcast({
    type: 'workflow:run:started',
    runId,
    name,
    tabId: tabId || undefined,
    steps: run.steps.map(s => ({ id: s.id, status: s.status })),
  });

  // Walk steps
  let currentStepId = stepEntries[0][0];
  const retryCount = {};

  try {
    while (currentStepId && !run.cancel) {
      const stepDef = workflow.steps[currentStepId];
      if (!stepDef) break;

      // --- Fan-out: parallel step spawns multiple steps concurrently ---
      if (stepDef.parallel && Array.isArray(stepDef.parallel)) {
        updateStepStatus(run, currentStepId, 'running', broadcaster, runId);
        broadcaster.broadcast({
          type: 'workflow:step:progress', runId, tabId: tabId || undefined, stepId: currentStepId,
          text: `Fan-out: spawning ${stepDef.parallel.length} parallel steps: ${stepDef.parallel.join(', ')}`,
        });

        const parallelResults = await Promise.allSettled(
          stepDef.parallel.map(async (pStepId) => {
            const pStepDef = workflow.steps[pStepId];
            if (!pStepDef || !pStepDef.do) return { id: pStepId, output: null, status: 'skipped' };

            updateStepStatus(run, pStepId, 'running', broadcaster, runId);
            const prompt = buildPrompt(pStepDef, ctx, workflow);
            const t0 = Date.now();
            try {
              const output = await executeStep(pStepId, prompt, pStepDef, {
                sessionManager, broadcaster, cwd,
                proxyPort, runId, tabId,
              });
              const elapsed = Date.now() - t0;
              ctx.steps[pStepId] = { output };
              updateStepStatus(run, pStepId, 'done', broadcaster, runId, elapsed);
              return { id: pStepId, output, status: 'done' };
            } catch (err) {
              const elapsed = Date.now() - t0;
              ctx.steps[pStepId] = { output: null, error: err.message };
              // Check for onError handler
              if (pStepDef.onError) {
                updateStepStatus(run, pStepId, 'failed', broadcaster, runId, elapsed);
                return { id: pStepId, status: 'failed', error: err.message, onError: pStepDef.onError };
              }
              updateStepStatus(run, pStepId, 'failed', broadcaster, runId, elapsed);
              throw err;
            }
          })
        );

        // Check for failures in parallel batch
        const failures = parallelResults.filter(r => r.status === 'rejected');
        ctx.steps[currentStepId] = {
          output: {
            parallel: stepDef.parallel,
            results: parallelResults.map(r => r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason?.message }),
          },
        };

        if (failures.length > 0) {
          updateStepStatus(run, currentStepId, 'failed', broadcaster, runId, 0);
          // Check for onError on the fan-out step itself
          if (stepDef.onError && workflow.steps[stepDef.onError]) {
            currentStepId = stepDef.onError;
            continue;
          }
          run.status = 'failed';
          break;
        }

        updateStepStatus(run, currentStepId, 'done', broadcaster, runId, 0);
        // Fan-in: jump to join step or next
        currentStepId = stepDef.join || stepDef.next || getNextStepId(stepEntries, currentStepId);
        continue;
      }

      // --- Condition-only step (no "do" field) ---
      if (stepDef.condition && !stepDef.do) {
        updateStepStatus(run, currentStepId, 'running', broadcaster, runId);
        const result = evaluateCondition(stepDef.condition, ctx);
        const branch = result ? (stepDef.then || null) : (stepDef.else || null);
        ctx.steps[currentStepId] = { output: { branch: result ? 'then' : 'else' } };
        updateStepStatus(run, currentStepId, 'done', broadcaster, runId, 0);
        broadcaster.broadcast({
          type: 'workflow:step:progress',
          runId,
          stepId: currentStepId,
          text: `Condition "${stepDef.condition}" → ${result ? 'then' : 'else'} → ${branch || 'end'}`,
        });
        currentStepId = branch;
        continue;
      }

      // --- Agent step — spawn claude -p ---
      if (stepDef.do) {
        updateStepStatus(run, currentStepId, 'running', broadcaster, runId);
        const prompt = buildPrompt(stepDef, ctx, workflow);
        const stepStartTime = Date.now();

        try {
          const output = await executeStep(currentStepId, prompt, stepDef, {
            sessionManager, broadcaster, cwd,
            proxyPort, runId, tabId,
          });
          const elapsed = Date.now() - stepStartTime;
          ctx.steps[currentStepId] = { output };
          updateStepStatus(run, currentStepId, 'done', broadcaster, runId, elapsed);
        } catch (err) {
          const elapsed = Date.now() - stepStartTime;
          ctx.steps[currentStepId] = { output: null, error: err.message };
          updateStepStatus(run, currentStepId, 'failed', broadcaster, runId, elapsed);

          // Check for onError handler
          if (stepDef.onError && workflow.steps[stepDef.onError]) {
            currentStepId = stepDef.onError;
            continue;
          }

          // Check for retry
          if (stepDef.maxRetries) {
            retryCount[currentStepId] = (retryCount[currentStepId] || 0) + 1;
            if (retryCount[currentStepId] < stepDef.maxRetries) {
              continue; // Retry same step
            }
          }
          // No retry — workflow failed
          run.status = 'failed';
          break;
        }

        // Determine next step
        if (stepDef.condition) {
          const result = evaluateCondition(stepDef.condition, ctx);
          if (result) {
            currentStepId = stepDef.then || stepDef.next || getNextStepId(stepEntries, currentStepId);
          } else {
            // Check retry
            if (stepDef.else) {
              if (stepDef.maxRetries) {
                retryCount[currentStepId] = (retryCount[currentStepId] || 0) + 1;
                if (retryCount[currentStepId] >= stepDef.maxRetries) {
                  currentStepId = stepDef.then || getNextStepId(stepEntries, currentStepId);
                  continue;
                }
              }
              currentStepId = stepDef.else;
            } else {
              currentStepId = stepDef.then || getNextStepId(stepEntries, currentStepId);
            }
          }
        } else {
          currentStepId = stepDef.next || getNextStepId(stepEntries, currentStepId);
        }
        continue;
      }

      // Unknown step type — skip
      currentStepId = stepDef.next || getNextStepId(stepEntries, currentStepId);
    }
  } catch (err) {
    run.status = 'failed';
    broadcaster.broadcast({ type: 'workflow:error', runId, tabId: tabId || undefined, error: err.message });
  }

  if (run.cancel) {
    run.status = 'cancelled';
  } else if (run.status === 'running') {
    run.status = 'completed';
  }

  broadcaster.broadcast({ type: 'workflow:run:complete', runId, tabId: tabId || undefined, status: run.status });

  // Save run
  saveRun(cwd, name, runId, run, ctx);
  activeRuns.delete(runId);

  return { runId, status: run.status };
}

function getNextStepId(stepEntries, currentId) {
  const idx = stepEntries.findIndex(([id]) => id === currentId);
  if (idx >= 0 && idx + 1 < stepEntries.length) return stepEntries[idx + 1][0];
  return null;
}

function updateStepStatus(run, stepId, status, broadcaster, runId, elapsed) {
  const step = run.steps.find(s => s.id === stepId);
  if (step) {
    step.status = status;
    if (elapsed !== undefined) step.elapsed = elapsed;
  }
  broadcaster.broadcast({
    type: status === 'running' ? 'workflow:step:start' : 'workflow:step:complete',
    runId,
    tabId: run.tabId || undefined,
    stepId,
    status,
    success: status === 'done',
    elapsed,
  });
}

function buildPrompt(stepDef, ctx, workflow) {
  let prompt = stepDef.do || '';

  // Replace {{input}} placeholders
  prompt = prompt.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return ctx.inputs[key] || `{{${key}}}`;
  });

  // Inject context from previous steps
  if (stepDef.context && Array.isArray(stepDef.context)) {
    const contextParts = [];
    for (const prevId of stepDef.context) {
      const prevOutput = ctx.steps[prevId]?.output;
      if (prevOutput) {
        const text = typeof prevOutput === 'string' ? prevOutput : JSON.stringify(prevOutput, null, 2);
        contextParts.push(`## Output from step "${prevId}":\n${text}`);
      }
    }
    if (contextParts.length > 0) {
      prompt = contextParts.join('\n\n') + '\n\n---\n\n' + prompt;
    }
  }

  // Add output format hint from "produces"
  if (stepDef.produces) {
    prompt += `\n\nExpected output format: ${stepDef.produces}`;
  }

  return prompt;
}

function evaluateCondition(condition, ctx) {
  // Simple keyword-based condition evaluation
  const lower = condition.toLowerCase();

  // Check for step output references
  for (const [stepId, stepData] of Object.entries(ctx.steps || {})) {
    if (lower.includes(stepId)) {
      const output = stepData?.output;
      // "there are findings from analyze" → check if output is non-empty
      if (lower.includes('no ') || lower.includes('not ') || lower.includes('empty')) {
        if (Array.isArray(output)) return output.length === 0;
        if (!output) return true;
        return false;
      }
      // "all tests pass"
      if (lower.includes('pass') || lower.includes('success')) {
        if (typeof output === 'object' && output !== null) {
          return output.passed === true || output.success === true;
        }
        return !!output;
      }
      // "there are findings" → non-empty
      if (Array.isArray(output)) return output.length > 0;
      return !!output;
    }
  }

  // Fallback: truthy if any step produced output
  return Object.values(ctx.steps || {}).some(s => s?.output);
}

/**
 * Execute a single workflow step by spawning claude -p.
 * Supports step-level timeout via stepDef.timeout (ms).
 */
function executeStep(stepId, prompt, stepDef, { sessionManager, broadcaster, cwd, proxyPort, runId, tabId }) {
  return new Promise((resolve, reject) => {
    // Build args for claude -p
    const args = ['-p', '--verbose', '--output-format', 'stream-json'];

    // Apply profile if specified
    const profileName = stepDef.profile;
    let profile = null;
    if (profileName) {
      profile = caps.loadProfile(cwd, profileName);
    }
    if (!profile) {
      profile = caps.loadActiveProfile(cwd);
    }

    if (profile) {
      if (profile.permissionMode && profile.permissionMode !== 'default') {
        args.push('--permission-mode', profile.permissionMode);
      }
      if (profile.disabledTools?.length > 0) {
        args.push('--disallowedTools', ...profile.disabledTools);
      }
      if (profile.model) {
        args.push('--model', profile.model);
      }
      if (profile.effort) {
        args.push('--effort', profile.effort);
      }
      if (profile.disableSlashCommands) {
        args.push('--disable-slash-commands');
      }
      if (profile.maxTurns) {
        args.push('--max-turns', String(profile.maxTurns));
      }
      if (profile.maxBudgetUsd) {
        args.push('--max-budget-usd', String(profile.maxBudgetUsd));
      }
      if (profile.appendSystemPrompt) {
        args.push('--append-system-prompt', profile.appendSystemPrompt);
      }
      if (profile.systemPrompt) {
        args.push('--system-prompt', profile.systemPrompt);
      }
    }

    // Set question context so proxy tags ask:question with workflow info
    if (tabId) setQuestionContext({ tabId, runId, stepId });

    const proc = spawn('claude', args, {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track proc on run for cancellation
    const run = activeRuns.get(runId);
    if (run) run.currentProc = proc;

    // Step-level timeout
    let timeoutTimer = null;
    let timedOut = false;
    const timeoutMs = stepDef.timeout || 0;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        broadcaster.broadcast({
          type: 'workflow:step:progress', runId, tabId: tabId || undefined, stepId,
          text: `\n[timeout] Step exceeded ${timeoutMs}ms limit — killing process`,
        });
        try { proc.kill('SIGTERM'); } catch {}
        // Force kill after 3s if SIGTERM didn't work
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      }, timeoutMs);
    }

    proc.stdin.write(prompt);
    proc.stdin.end();

    let buffer = '';
    let result = null;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Broadcast progress
          if (event.type === 'content_block_delta' && event.delta?.text) {
            broadcaster.broadcast({
              type: 'workflow:step:progress',
              runId, tabId: tabId || undefined,
              stepId,
              text: event.delta.text,
            });
          }
          if (event.type === 'result' && event.result) {
            result = event.result;
          }
        } catch {}
      }
    });

    proc.stderr.on('data', (chunk) => {
      broadcaster.broadcast({
        type: 'workflow:step:progress',
        runId, tabId: tabId || undefined,
        stepId,
        text: `[stderr] ${chunk.toString('utf-8')}`,
      });
    });

    proc.on('close', (code) => {
      if (run) run.currentProc = null;
      if (tabId) clearQuestionContext();
      if (timeoutTimer) clearTimeout(timeoutTimer);

      // Flush buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'result' && event.result) result = event.result;
        } catch {}
      }

      if (timedOut) {
        reject(new Error(`Step "${stepId}" timed out after ${timeoutMs}ms`));
      } else if (code !== 0 && !result) {
        reject(new Error(`Step "${stepId}" exited with code ${code}`));
      } else {
        resolve(result || '');
      }
    });

    proc.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      reject(new Error(`Step "${stepId}" failed to start: ${err.message}`));
    });
  });
}

function cancelRun(runId) {
  const run = activeRuns.get(runId);
  if (run) {
    run.cancel = true;
    if (run.currentProc) {
      try { run.currentProc.kill('SIGTERM'); } catch {}
    }
    return true;
  }
  return false;
}

function getRunStatus(runId) {
  const run = activeRuns.get(runId);
  if (!run) return null;
  return {
    runId,
    name: run.name,
    status: run.status,
    steps: run.steps.map(s => ({ id: s.id, status: s.status, elapsed: s.elapsed })),
    currentStep: run.steps.find(s => s.status === 'running')?.id || null,
  };
}

function saveRun(cwd, name, runId, run, ctx) {
  try {
    const runsDir = path.join(workflowsDir(cwd), name, 'runs');
    ensureDir(runsDir);
    const runData = {
      runId,
      name,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: Date.now(),
      steps: run.steps.map(s => ({
        id: s.id,
        status: s.status,
        elapsed: s.elapsed,
        output: ctx.steps[s.id]?.output || null,
        error: ctx.steps[s.id]?.error || null,
      })),
      inputs: ctx.inputs,
    };
    fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify(runData, null, 2));
  } catch (err) {
    console.error(`[workflow] Failed to save run ${runId}:`, err.message);
  }
}

// ============================================================
// GENERATION — claude -p brainstorms workflow from description
// ============================================================

function generateWorkflow(description, feedback, { proxyPort, cwd, envContext }) {
  return new Promise((resolve, reject) => {
    let envSection = '';
    if (envContext) {
      const parts = [];
      if (envContext.profiles?.length) {
        parts.push('Available profiles (use in step "profile" field):\n' +
          envContext.profiles.map(p => `  - "${p.name}": ${p.description || '(no description)'}${p.model ? ` [model: ${p.model}]` : ''}`).join('\n'));
      }
      if (envContext.tools?.length) {
        parts.push('Available MCP tools (Claude can call these during step execution):\n' +
          envContext.tools.map(t => `  - ${t.name}: ${t.description || '(no description)'}${t.params?.length ? ' — params: ' + t.params.map(p => p.name).join(', ') : ''}`).join('\n'));
      }
      if (envContext.workflows?.length) {
        parts.push('Other existing workflows (can be invoked via the workflow_run MCP tool):\n' +
          envContext.workflows.map(w => `  - ${w.name}: ${w.description || '(no description)'}`).join('\n'));
      }
      if (parts.length) envSection = '\n\nEnvironment context:\n' + parts.join('\n\n');
    }

    let prompt = `You are a workflow designer. Create a workflow JSON definition based on this description:

"${description}"

${feedback ? `Additional feedback from the user: "${feedback}"` : ''}${envSection}

Output ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "name": "kebab-case-name",
  "description": "what this workflow does",
  "inputs": {
    "key": "description of this input"
  },
  "steps": {
    "step-name": {
      "profile": "full",
      "do": "natural language instruction for this step",
      "produces": "description of expected output",
      "context": ["previous-step-ids"],
      "condition": "optional: natural language condition",
      "then": "step-if-true",
      "else": "step-if-false",
      "next": "explicit-next-step",
      "maxRetries": 3
    }
  }
}

Rules:
- Each step's "do" field should be a clear instruction, as if you're telling a developer what to do
- Use "context" to reference outputs from previous steps that this step needs
- Use "condition" for branching decisions
- The first step in the object is the entry point
- Steps execute in order unless overridden by "next", "then", or "else"
- When a step needs user input or confirmation, instruct it to use the AskUserQuestion tool
- If a step can leverage an existing MCP tool (listed above), mention the tool by name in the "do" instruction
- If a step can delegate to another workflow, use the workflow_run MCP tool
- Choose the most appropriate profile for each step based on what it needs to do
- Always include a final summary step`;

    const args = ['-p', '--verbose', '--output-format', 'stream-json'];

    const proc = spawn('claude', args, {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Timeout: kill after 2 minutes
    const genTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 120000);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let buffer = '';
    let stderrBuf = '';
    let result = null;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result' && event.result) result = event.result;
        } catch {}
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf-8');
    });

    proc.on('close', (code) => {
      clearTimeout(genTimeout);

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'result' && event.result) result = event.result;
        } catch {}
      }

      if (!result) {
        const detail = stderrBuf.trim() ? `: ${stderrBuf.trim()}` : '';
        reject(new Error(`Generation produced no output (exit ${code})${detail}`));
        return;
      }

      // Extract JSON from result
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const workflow = JSON.parse(jsonMatch[0]);
          resolve(workflow);
        } else {
          reject(new Error('No JSON found in generation output'));
        }
      } catch (e) {
        reject(new Error(`Failed to parse generated workflow: ${e.message}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(genTimeout);
      reject(new Error(`Generation failed: ${err.message}`));
    });
  });
}

// ============================================================
// COMPILATION — claude -p transforms source JSON to executable JS
// ============================================================

function compileWorkflow(name, { proxyPort, cwd, broadcaster, envContext }) {
  return new Promise((resolve, reject) => {
    const workflow = loadWorkflow(cwd, name);
    if (!workflow) { reject(new Error(`Workflow not found: ${name}`)); return; }

    const sourceContent = JSON.stringify(workflow, null, 2);
    const sourceHash = hashContent(sourceContent);
    const compiledPath = path.join(workflowsDir(cwd), name, 'compiled.js');

    let envSection = '';
    if (envContext) {
      const parts = [];
      if (envContext.tools?.length) {
        parts.push('Available MCP tools that steps can call:\n' +
          envContext.tools.map(t => `  - ${t.name}: ${t.description || ''}${t.params?.length ? ' — params: ' + t.params.map(p => `${p.name}(${p.type})`).join(', ') : ''}`).join('\n'));
      }
      if (envContext.workflows?.length) {
        parts.push('Other workflows (callable via workflow_run tool):\n' +
          envContext.workflows.map(w => `  - ${w.name}: ${w.description || ''}`).join('\n'));
      }
      if (parts.length) envSection = '\n\nEnvironment context (tools/workflows the steps can use):\n' + parts.join('\n\n') + '\n';
    }

    const prompt = `You are a workflow compiler. Transform this workflow JSON into a compiled CommonJS JavaScript module.

Source workflow.json:
\`\`\`json
${sourceContent}
\`\`\`
${envSection}
Write the compiled JavaScript to: ${compiledPath}

The module must export:

module.exports = {
  name: "${workflow.name}",
  sourceHash: "${sourceHash}",
  inputs: {
    // key: { type: "string", required: true/false, description: "..." }
  },
  steps: [
    {
      id: "step-name",
      profile: "profile-name" || null,
      type: "agent" || "condition",
      // For agent steps:
      buildPrompt(ctx) { return "the prompt string with ctx.inputs.X and ctx.steps.Y.output injected"; },
      parseOutput(raw) { return raw; }, // extract structured data from raw text
      // For condition steps:
      evaluate(ctx) { return true/false; },
      // Navigation:
      next: "step-id" || null,
      then: "step-id" || null,  // if condition is true
      else: "step-id" || null,  // if condition is false
      maxRetries: N || undefined,
    }
  ]
};

Rules:
- Convert "do" text into buildPrompt(ctx) that injects context from previous steps via ctx.steps[id].output
- Convert "condition" text into evaluate(ctx) JS predicate — deterministic, no AI call needed
- Convert "produces" into parseOutput(raw) that extracts the expected shape
- Wire data flow explicitly: if step B has context: ["A"], then B's buildPrompt must reference ctx.steps.A.output
- The steps array must be in execution order
- Use the exact sourceHash provided
- Output rendering supports full Markdown, MathJax ($...$ and $$...$$), and fenced code blocks. When a step produces visual output (diagrams, UI, formulas), use these formats:
  - Markdown tables, lists, headings for structured text
  - \`\`\`html for rendered HTML content (iframes, styled elements)
  - \`\`\`svg for inline SVG diagrams and charts
  - LaTeX math via $inline$ or $$display$$ for equations
  - Standard \`\`\`language for code snippets`;

    const args = ['-p', '--verbose', '--output-format', 'stream-json'];

    const proc = spawn('claude', args, {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Timeout: kill after 2 minutes
    const compileTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 120000);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let buffer = '';
    let stderrBuf = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'content_block_delta' && event.delta?.text && broadcaster) {
            broadcaster.broadcast({ type: 'workflow:compile:progress', name, text: event.delta.text });
          }
        } catch {}
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf-8');
    });

    proc.on('close', (code) => {
      clearTimeout(compileTimeout);

      // Read the compiled file from disk — claude -p writes it directly
      try {
        if (fs.existsSync(compiledPath)) {
          const compiledSource = fs.readFileSync(compiledPath, 'utf8');
          resolve({ name, success: true, sourceHash, compiledSource });
        } else {
          const detail = stderrBuf.trim() ? `: ${stderrBuf.trim()}` : '';
          reject(new Error(`Compilation did not produce compiled.js (exit ${code})${detail}`));
        }
      } catch (e) {
        reject(new Error(`Failed to read compiled.js: ${e.message}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(compileTimeout);
      reject(new Error(`Compilation failed: ${err.message}`));
    });
  });
}

module.exports = {
  listWorkflows,
  loadWorkflow,
  loadCompiledSource,
  saveWorkflow,
  saveCompiledSource,
  deleteWorkflow,
  runWorkflow,
  cancelRun,
  getRunStatus,
  generateWorkflow,
  compileWorkflow,
  hashContent,
  activeRuns,
};
