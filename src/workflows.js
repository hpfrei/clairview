// ============================================================
// Workflow Engine — CRUD + runtime for multi-step workflows
// Each step spawns a full claude -p session via ClaudeSessionManager
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const caps = require('./capabilities');
const { buildClaudeArgs, spawnClaude, createStreamJsonParser, ensureDir, listFiles } = require('./utils');

const PROJECT_ROOT = path.dirname(__dirname);

const WORKFLOWS_DIR = 'capabilities/workflows';

// ============================================================
// CRUD
// ============================================================

function workflowsDir(cwd) {
  return path.join(cwd || process.cwd(), WORKFLOWS_DIR);
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
        inputMode: src.inputMode || 'none',
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

function loadCompiledModule(cwd, name) {
  const compiledPath = path.join(workflowsDir(cwd), name, 'compiled.js');
  if (!fs.existsSync(compiledPath)) return null;
  try {
    // Bust require cache so re-compilations are picked up
    delete require.cache[require.resolve(compiledPath)];
    const mod = require(compiledPath);
    if (!mod || !Array.isArray(mod.steps)) {
      console.warn(`[workflow] compiled.js for "${name}" has no steps array — ignoring`);
      return null;
    }
    return mod;
  } catch (err) {
    console.warn(`[workflow] Failed to load compiled.js for "${name}": ${err.message}`);
    return null;
  }
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

function renameWorkflow(cwd, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) return false;
  const oldDir = path.join(workflowsDir(cwd), oldName);
  const newDir = path.join(workflowsDir(cwd), newName);
  if (!fs.existsSync(oldDir)) return false;
  if (fs.existsSync(newDir)) return false; // target already exists
  fs.renameSync(oldDir, newDir);
  // Update name inside workflow.json
  const jsonPath = path.join(newDir, 'workflow.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const wf = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      wf.name = newName;
      fs.writeFileSync(jsonPath, JSON.stringify(wf, null, 2));
    } catch {}
  }
  // Update name inside compiled.js (rewrite the name property)
  const compiledPath = path.join(newDir, 'compiled.js');
  if (fs.existsSync(compiledPath)) {
    try {
      let src = fs.readFileSync(compiledPath, 'utf-8');
      // Replace the name field in the module.exports object
      src = src.replace(/name:\s*["'].*?["']/, `name: "${newName}"`);
      fs.writeFileSync(compiledPath, src);
    } catch {}
  }
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

// Active runs: runId → { status, name, steps, ctx, cancel, procs }
const activeRuns = new Map();

function getStepField(compiledStep, jsonStepDef, field) {
  if (compiledStep && compiledStep[field] !== undefined) return compiledStep[field];
  return jsonStepDef ? jsonStepDef[field] : undefined;
}

function safeCall(fn, fallback, label) {
  try { return fn(); } catch (err) {
    console.warn(`[workflow] ${label}: ${err.message}`);
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function generateRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Run a workflow. Each agent step spawns a full claude -p session.
 */
async function runWorkflow(name, inputs, { sessionManager, broadcaster, cwd, tabId, proxyPort, dashboardPort, authToken }) {
  const workflow = loadWorkflow(PROJECT_ROOT, name);
  if (!workflow) throw new Error(`Workflow not found: ${name}`);

  // Prefer compiled module when available
  const compiled = loadCompiledModule(PROJECT_ROOT, name);
  const useCompiled = !!compiled;
  const compiledStepMap = new Map();
  if (compiled) {
    for (const step of compiled.steps) compiledStepMap.set(step.id, step);
  }

  const runId = generateRunId();
  const stepEntries = Object.entries(workflow.steps || {});
  if (stepEntries.length === 0) throw new Error('Workflow has no steps');

  // Build context
  const ctx = {
    inputs: { ...(workflow.inputs || {}), ...inputs },
    steps: {},
  };

  // Resolve input template values — handle both JSON ("desc") and compiled ({ type, description }) formats
  const inputDefs = useCompiled && compiled.inputs ? compiled.inputs : (workflow.inputs || {});
  for (const [key, def] of Object.entries(inputDefs)) {
    const desc = typeof def === 'string' ? def : (def?.description || '');
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
    procs: new Set(),
    startedAt: Date.now(),
  };
  activeRuns.set(runId, run);

  broadcaster.broadcast({
    type: 'workflow:run:started',
    runId,
    name,
    compiled: useCompiled,
    tabId: tabId || undefined,
    steps: run.steps.map(s => ({ id: s.id, status: s.status, profile: s.profile || null })),
  });

  // Walk steps
  let currentStepId = stepEntries[0][0];
  const retryCount = {};

  try {
    while (currentStepId && !run.cancel) {
      const jsonStepDef = workflow.steps[currentStepId];
      const compiledStep = compiledStepMap.get(currentStepId);
      if (!jsonStepDef && !compiledStep) break;

      const parallel = getStepField(compiledStep, jsonStepDef, 'parallel');
      const onError = getStepField(compiledStep, jsonStepDef, 'onError');

      // --- Fan-out: parallel step spawns multiple steps concurrently ---
      if (parallel && Array.isArray(parallel)) {
        updateStepStatus(run, currentStepId, 'running', broadcaster, runId);
        broadcaster.broadcast({
          type: 'workflow:step:progress', runId, tabId: tabId || undefined, stepId: currentStepId,
          text: `Fan-out: spawning ${parallel.length} parallel steps: ${parallel.join(', ')}`,
        });

        const parallelResults = await Promise.allSettled(
          parallel.map(async (pStepId) => {
            const pJsonDef = workflow.steps[pStepId];
            const pCompiled = compiledStepMap.get(pStepId);
            if (!pCompiled && (!pJsonDef || !pJsonDef.do)) return { id: pStepId, output: null, status: 'skipped' };

            updateStepStatus(run, pStepId, 'running', broadcaster, runId);
            const prompt = safeCall(
              () => pCompiled?.buildPrompt ? pCompiled.buildPrompt(ctx) : buildPrompt(pJsonDef, ctx, workflow),
              () => buildPrompt(pJsonDef, ctx, workflow),
              `buildPrompt failed for parallel step "${pStepId}"`
            );
            const execDef = {
              profile: getStepField(pCompiled, pJsonDef, 'profile'),
              timeout: getStepField(pCompiled, pJsonDef, 'timeout'),
              disallowedTools: getStepField(pCompiled, pJsonDef, 'disallowedTools'),
              allowedTools: getStepField(pCompiled, pJsonDef, 'allowedTools'),
            };
            const t0 = Date.now();
            try {
              const rawOutput = await executeStep(pStepId, prompt, execDef, {
                sessionManager, broadcaster, cwd,
                proxyPort, runId, tabId, dashboardPort, authToken, workflowName: name,
              });
              const elapsed = Date.now() - t0;
              const parsed = safeCall(
                () => pCompiled?.parseOutput ? pCompiled.parseOutput(rawOutput) : rawOutput,
                rawOutput,
                `parseOutput failed for parallel step "${pStepId}"`
              );
              ctx.steps[pStepId] = { output: parsed };
              updateStepStatus(run, pStepId, 'done', broadcaster, runId, elapsed, rawOutput);
              return { id: pStepId, output: parsed, status: 'done' };
            } catch (err) {
              const elapsed = Date.now() - t0;
              ctx.steps[pStepId] = { output: null, error: err.message };
              const pOnError = getStepField(pCompiled, pJsonDef, 'onError');
              if (pOnError) {
                updateStepStatus(run, pStepId, 'failed', broadcaster, runId, elapsed);
                return { id: pStepId, status: 'failed', error: err.message, onError: pOnError };
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
            parallel,
            results: parallelResults.map(r => r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason?.message }),
          },
        };

        // If cancelled during parallel execution, break immediately
        if (run.cancel) {
          updateStepStatus(run, currentStepId, 'failed', broadcaster, runId, 0);
          break;
        }

        if (failures.length > 0) {
          updateStepStatus(run, currentStepId, 'failed', broadcaster, runId, 0);
          if (onError && workflow.steps[onError]) {
            currentStepId = onError;
            continue;
          }
          run.status = 'failed';
          break;
        }

        updateStepStatus(run, currentStepId, 'done', broadcaster, runId, 0);
        currentStepId = getStepField(compiledStep, jsonStepDef, 'join')
          || getStepField(compiledStep, jsonStepDef, 'next')
          || getNextStepId(stepEntries, currentStepId);
        continue;
      }

      // --- Condition-only step (no agent work) ---
      const isConditionOnly = compiledStep?.type === 'condition' || (jsonStepDef?.condition && !jsonStepDef?.do);
      if (isConditionOnly) {
        updateStepStatus(run, currentStepId, 'running', broadcaster, runId);
        const result = safeCall(
          () => compiledStep?.evaluate ? compiledStep.evaluate(ctx) : evaluateCondition(jsonStepDef.condition, ctx),
          () => evaluateCondition(jsonStepDef?.condition || '', ctx),
          `evaluate failed for condition step "${currentStepId}"`
        );
        const branch = result
          ? (getStepField(compiledStep, jsonStepDef, 'then') || null)
          : (getStepField(compiledStep, jsonStepDef, 'else') || null);
        ctx.steps[currentStepId] = { output: { branch: result ? 'then' : 'else' } };
        updateStepStatus(run, currentStepId, 'done', broadcaster, runId, 0);
        broadcaster.broadcast({
          type: 'workflow:step:progress', runId, stepId: currentStepId,
          text: `Condition → ${result ? 'then' : 'else'} → ${branch || 'end'}`,
        });
        currentStepId = branch;
        continue;
      }

      // --- Agent step — spawn claude -p ---
      const hasAgent = compiledStep?.type === 'agent' || compiledStep?.buildPrompt || jsonStepDef?.do;
      if (hasAgent) {
        updateStepStatus(run, currentStepId, 'running', broadcaster, runId);
        const prompt = safeCall(
          () => compiledStep?.buildPrompt ? compiledStep.buildPrompt(ctx) : buildPrompt(jsonStepDef, ctx, workflow),
          () => buildPrompt(jsonStepDef, ctx, workflow),
          `buildPrompt failed for step "${currentStepId}"`
        );
        const execDef = {
          profile: getStepField(compiledStep, jsonStepDef, 'profile'),
          timeout: getStepField(compiledStep, jsonStepDef, 'timeout'),
          disallowedTools: getStepField(compiledStep, jsonStepDef, 'disallowedTools'),
          allowedTools: getStepField(compiledStep, jsonStepDef, 'allowedTools'),
        };
        const stepStartTime = Date.now();

        try {
          const rawOutput = await executeStep(currentStepId, prompt, execDef, {
            sessionManager, broadcaster, cwd,
            proxyPort, runId, tabId, dashboardPort, authToken, workflowName: name,
          });
          const elapsed = Date.now() - stepStartTime;
          const parsed = safeCall(
            () => compiledStep?.parseOutput ? compiledStep.parseOutput(rawOutput) : rawOutput,
            rawOutput,
            `parseOutput failed for step "${currentStepId}"`
          );
          ctx.steps[currentStepId] = { output: parsed };
          updateStepStatus(run, currentStepId, 'done', broadcaster, runId, elapsed, rawOutput);
        } catch (err) {
          const elapsed = Date.now() - stepStartTime;
          ctx.steps[currentStepId] = { output: null, error: err.message };
          updateStepStatus(run, currentStepId, 'failed', broadcaster, runId, elapsed);

          if (run.cancel) break;

          if (onError && workflow.steps[onError]) {
            currentStepId = onError;
            continue;
          }

          const maxRetries = getStepField(compiledStep, jsonStepDef, 'maxRetries');
          if (maxRetries) {
            retryCount[currentStepId] = (retryCount[currentStepId] || 0) + 1;
            if (retryCount[currentStepId] < maxRetries) {
              continue;
            }
          }
          run.status = 'failed';
          break;
        }

        // Determine next step — check for post-agent condition
        const hasCondition = compiledStep?.evaluate || jsonStepDef?.condition;
        if (hasCondition) {
          const result = safeCall(
            () => compiledStep?.evaluate ? compiledStep.evaluate(ctx) : evaluateCondition(jsonStepDef.condition, ctx),
            () => evaluateCondition(jsonStepDef?.condition || '', ctx),
            `evaluate failed for step "${currentStepId}"`
          );
          if (result) {
            currentStepId = getStepField(compiledStep, jsonStepDef, 'then')
              || getStepField(compiledStep, jsonStepDef, 'next')
              || getNextStepId(stepEntries, currentStepId);
          } else {
            const elseStep = getStepField(compiledStep, jsonStepDef, 'else');
            if (elseStep) {
              const maxRetries = getStepField(compiledStep, jsonStepDef, 'maxRetries');
              if (maxRetries) {
                retryCount[currentStepId] = (retryCount[currentStepId] || 0) + 1;
                if (retryCount[currentStepId] >= maxRetries) {
                  currentStepId = getStepField(compiledStep, jsonStepDef, 'then') || getNextStepId(stepEntries, currentStepId);
                  continue;
                }
              }
              currentStepId = elseStep;
            } else {
              currentStepId = getStepField(compiledStep, jsonStepDef, 'then') || getNextStepId(stepEntries, currentStepId);
            }
          }
        } else {
          currentStepId = getStepField(compiledStep, jsonStepDef, 'next') || getNextStepId(stepEntries, currentStepId);
        }
        continue;
      }

      // Unknown step type — skip
      currentStepId = getStepField(compiledStep, jsonStepDef, 'next') || getNextStepId(stepEntries, currentStepId);
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

  // Find the last completed step's output for the MCP result
  let finalOutput = null;
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const s = run.steps[i];
    if (s.status === 'done' && ctx.steps[s.id]?.output) {
      const out = ctx.steps[s.id].output;
      finalOutput = typeof out === 'string' ? out : JSON.stringify(out);
      break;
    }
  }

  broadcaster.broadcast({ type: 'workflow:run:complete', runId, tabId: tabId || undefined, status: run.status, output: finalOutput });

  // Broadcast output files from the working directory
  const outputFiles = listFiles(cwd);
  if (outputFiles.length) {
    broadcaster.broadcast({ type: 'files:list', tabId: tabId || undefined, cwd, files: outputFiles });
  }

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

function updateStepStatus(run, stepId, status, broadcaster, runId, elapsed, output) {
  const step = run.steps.find(s => s.id === stepId);
  if (step) {
    step.status = status;
    if (elapsed !== undefined) step.elapsed = elapsed;
  }
  const msg = {
    type: status === 'running' ? 'workflow:step:start' : 'workflow:step:complete',
    runId,
    tabId: run.tabId || undefined,
    stepId,
    status,
    success: status === 'done',
    elapsed,
  };
  if (output !== undefined) msg.output = typeof output === 'string' ? output : JSON.stringify(output);
  broadcaster.broadcast(msg);
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
function executeStep(stepId, prompt, stepDef, { sessionManager, broadcaster, cwd, proxyPort, runId, tabId, dashboardPort, authToken, workflowName }) {
  return new Promise((resolve, reject) => {
    const profile = (stepDef.profile && caps.loadProfile(PROJECT_ROOT, stepDef.profile)) || caps.loadActiveProfile(PROJECT_ROOT);
    const args = buildClaudeArgs(profile);

    // Step-level tool overrides (structural recursion prevention)
    if (stepDef.disallowedTools?.length) {
      args.push('--disallowedTools', ...stepDef.disallowedTools);
    }
    if (stepDef.allowedTools?.length) {
      args.push('--allowedTools', ...stepDef.allowedTools);
    }

    // Ensure hook reporters in spawn CWD
    const reporterPath = path.join(PROJECT_ROOT, 'lib', 'hook-reporter.js');
    caps.ensureHookReporters(cwd, reporterPath);

    const proc = spawnClaude(args, {
      cwd, proxyPort,
      profileName: profile.name || 'full',
      disableAutoMemory: profile.disableAutoMemory !== false,
      dashboardPort, authToken,
      instanceId: `wf-${runId}-${stepId}`,
      sourceContext: tabId ? { tabId, runId, stepId } : null,
    });

    const run = activeRuns.get(runId);
    if (run) {
      run.currentProc = proc;
      run.procs.add(proc);
    }

    // Bail immediately if already cancelled
    if (run?.cancel) {
      try { proc.kill('SIGTERM'); } catch {}
      // Don't wait — reject right away
      reject(new Error(`Cancelled`));
      return;
    }

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
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      }, timeoutMs);
    }

    proc.stdin.write(prompt);
    proc.stdin.end();

    let result = null;
    const parser = createStreamJsonParser((event) => {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        broadcaster.broadcast({
          type: 'workflow:step:progress', runId, tabId: tabId || undefined, stepId,
          text: event.delta.text,
        });
      }
      if (event.type === 'result' && event.result) result = event.result;
    });

    proc.stdout.on('data', (chunk) => parser.write(chunk));

    proc.stderr.on('data', (chunk) => {
      broadcaster.broadcast({
        type: 'workflow:step:progress', runId, tabId: tabId || undefined, stepId,
        text: `[stderr] ${chunk.toString('utf-8')}`,
      });
    });

    proc.on('close', (code) => {
      if (run) {
        run.currentProc = null;
        run.procs.delete(proc);
      }
      if (timeoutTimer) clearTimeout(timeoutTimer);
      parser.flush();

      if (run?.cancel) {
        reject(new Error(`Cancelled`));
      } else if (timedOut) {
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
    // Kill all tracked processes (covers parallel fan-out)
    for (const proc of run.procs) {
      try { proc.kill('SIGTERM'); } catch {}
    }
    // SIGKILL fallback after 3s for any stubborn processes
    setTimeout(() => {
      for (const proc of run.procs) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, 3000);
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

function generateWorkflow(description, feedback, { proxyPort, cwd, envContext, existingName }) {
  return new Promise((resolve, reject) => {
    // Delete existing workflow.json so the spawned claude doesn't read it and skip generating
    if (existingName) {
      const existingPath = path.join(workflowsDir(cwd), existingName, 'workflow.json');
      try { fs.unlinkSync(existingPath); } catch {}
    }

    let envSection = '';
    if (envContext) {
      const parts = [];
      if (envContext.profiles?.length) {
        parts.push('Available profiles (use in step "profile" field):\n' +
          envContext.profiles.map(p => {
            const caps = p.capabilities?.length ? p.capabilities.join(', ') : '(none)';
            return `  - "${p.name}": ${p.description || '(no description)'}${p.model ? ` [model: ${p.model}]` : ''}\n    Tools: ${caps}`;
          }).join('\n'));
      }
      if (envContext.tools?.length) {
        parts.push('Available MCP tools (Claude can call these during step execution):\n' +
          envContext.tools.map(t => `  - ${t.name}: ${t.description || '(no description)'}${t.params?.length ? ' — params: ' + t.params.map(p => p.name).join(', ') : ''}`).join('\n'));
      }
      if (envContext.workflows?.length) {
        parts.push('Other existing workflows (available as MCP tools by name — hyphens become underscores, -workflow suffix stripped):\n' +
          envContext.workflows.map(w => `  - ${w.name} → tool: ${w.name.replace(/-workflow$/, '').replace(/-/g, '_')}: ${w.description || '(no description)'}`).join('\n'));
      }
      if (parts.length) envSection = '\n\nEnvironment context:\n' + parts.join('\n\n');
    }

    // Compute target path — agent writes the file directly (same pattern as compileWorkflow)
    const targetDir = existingName
      ? path.join(workflowsDir(cwd), existingName)
      : path.join(workflowsDir(cwd), `wf-draft-${Date.now()}`);
    ensureDir(targetDir);
    const targetPath = path.join(targetDir, 'workflow.json');

    let prompt = `You are a workflow designer. Create a workflow JSON definition based on this description:

"${description}"

${feedback ? `Additional feedback from the user: "${feedback}"` : ''}${envSection}

## Core principle

Each step spawns a FULL Claude Code agent session (claude -p). A single step can read files, write files, run shell commands, search the web, spawn sub-agents, use multi-turn reasoning, call MCP tools, and interact with the user via AskUserQuestion. Treat steps like separate work sessions — not like function calls or lines of code.

Most workflows should have 2-4 steps. A step that explores a codebase, searches the web for documentation, validates feasibility, AND writes the result is perfectly normal. Only create a new step when the work genuinely requires a separate session — for example, when a later step needs to react to the complete output of an earlier one, or when different security profiles are needed.

## Output

Write the workflow definition as valid JSON to this file:
${targetPath}

Use the Write tool to create the file. Write ONLY the JSON — no markdown fences, no explanation. The JSON format:
{
  "name": "kebab-case-name",
  "description": "Concise action phrase — becomes the MCP tool description (e.g., 'Analyze a codebase and generate a dependency report')",
  "inputs": {
    "key": "description — shorthand for a required string parameter",
    "key": { "type": "string|number|boolean", "description": "what this parameter does", "required": true }
  },
  "steps": {
    "step-name": {
      "profile": "full",
      "do": "Natural language instruction — be detailed, this is the full brief for an autonomous agent",
      "produces": "Description of expected output",
      "context": ["previous-step-id"]
    }
  }
}

## Good vs bad decomposition

BAD — over-decomposed (7 steps for adding a model):
  1. analyze-current-setup → read config files
  2. research-model → web search
  3. validate-adapter → check compatibility
  4. check-adapter-validation → condition branch
  5. confirm-with-user → show JSON, ask approval
  6. write-model-entry → write to file
  7. summary → recap what happened

GOOD — same task in 3 steps:
  1. research-and-validate → Read the existing config files AND search the web for the model specs AND check adapter compatibility. Output the complete findings or a clear reason why the model cannot be added.
  2. add-model → Using the research, build the JSON entry, present it to the user via AskUserQuestion for confirmation, then write it to the config file. Handle any user adjustments in the same session.
  3. verify → Read back the file to confirm the write succeeded. Summarize what was added and remind the user about API key setup if needed.

BAD — unnecessary separation:
  1. gather-requirements → ask user what they want
  2. validate-requirements → check if the request makes sense
  3. plan-implementation → design the approach
  4. implement → do the work
  5. verify → check the work
  6. summarize → tell user what happened

GOOD — consolidated:
  1. gather-and-plan → Ask the user what they need (via AskUserQuestion), then analyze the codebase and design the approach. Output the plan.
  2. implement-and-verify → Execute the plan, verify the results, and present a summary to the user.

## Rules

Step mechanics:
- The first step in the "steps" object is the entry point
- Steps execute in declared order unless overridden by "next"
- Use "context" to pass output from previous steps — the referenced step's output is injected into the prompt automatically
- Each step's "do" field should be a thorough brief: the agent has no memory of other steps beyond what "context" provides
- Use "produces" to describe what the step outputs (this helps downstream steps and the runtime)
- When a step needs user input or confirmation, instruct it to use the AskUserQuestion tool — this does NOT require a separate step

Naming and inputs:
- IMPORTANT: This workflow becomes an MCP tool. The "name" becomes the tool name (hyphens → underscores, "-workflow" suffix stripped, e.g., "analyze-code" → tool named "analyze_code"). The "description" becomes the tool description visible to the LLM.
- The "inputs" object defines the tool's typed parameters — each key becomes a named parameter the caller passes when invoking the tool
- Use clear, descriptive parameter names like function arguments (e.g., "file_path", "language", "max_results") — avoid generic names like "input" or "data"
- String value is shorthand for a required string param. Use object form { type, description, required } for non-string types or optional params.
- Only define inputs the workflow truly needs from the caller. If a step gathers info interactively (via AskUserQuestion), that is NOT an input.
- Steps reference inputs via {{key}} placeholders in their "do" text. Every defined input must be used by at least one step.

Profiles:
- Match each step's profile to its requirements using the capabilities listed above
- Steps that write or edit files MUST use a profile with Write/Edit tools
- Steps that run shell commands MUST use a profile with Bash
- Steps that search the web MUST use a profile with WebSearch/WebFetch
- Steps that only read/analyze code can use a read-only profile
- Only use profiles from the "Available profiles" list above

Integration:
- If a step can leverage an existing MCP tool (listed above), mention the tool by name in the "do" instruction
- If a step can delegate to another workflow, call it directly by its tool name (e.g., analyze_code)
- IMPORTANT: The workflow itself becomes an MCP tool that steps can call. If a step's task overlaps with the workflow's overall purpose, its "do" text should explicitly instruct the agent to complete the task directly rather than re-invoking the workflow tool. This prevents infinite recursion. Only add this warning when confusion risk exists.

## Advanced features (use sparingly — most workflows need none of these)

These fields are supported but rarely needed. Do NOT use them unless the workflow genuinely requires them:
- "condition" + "then"/"else": Branch based on a step's output. Only needed when the workflow has truly divergent paths (not just error checking — agents handle errors naturally).
- "next": Override the default sequential flow to jump to a specific step.
- "parallel" + "join": Fan out to run multiple steps concurrently, then converge. Only useful when independent workstreams can genuinely run in parallel.
- "maxRetries": Retry a step on failure. Rarely needed — agents are resilient.
- "timeout": Kill a step after N milliseconds. Only for steps that might genuinely hang.
- "onError": Redirect to a fallback step on failure. Rarely needed — prefer letting the agent handle errors within the step.

When tempted to use conditions or branching, first ask: could the agent within a single step handle both paths? Usually yes.`;

    const args = buildClaudeArgs(caps.loadProfile(PROJECT_ROOT, 'full'));
    const proc = spawnClaude(args, { cwd, proxyPort, profileName: 'full', instanceId: `wf-generate-${Date.now()}` });

    const genTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 300000);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stderrBuf = '';
    proc.stdout.on('data', () => {}); // drain stdout
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });

    proc.on('close', (code) => {
      clearTimeout(genTimeout);

      if (!fs.existsSync(targetPath)) {
        const detail = stderrBuf.trim() ? `: ${stderrBuf.trim()}` : '';
        reject(new Error(`Generation produced no output file (exit ${code})${detail}`));
        return;
      }

      try {
        const workflow = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
        // If we used a temp draft dir, clean it up — the caller will save to the real name
        if (!existingName) {
          try { fs.unlinkSync(targetPath); fs.rmdirSync(targetDir); } catch {}
        }
        resolve(workflow);
      } catch (e) {
        reject(new Error(`Failed to parse generated workflow file: ${e.message}`));
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

    // Delete existing compiled.js so the spawned claude doesn't see it and skip writing
    try { fs.unlinkSync(compiledPath); } catch {}

    let envSection = '';
    if (envContext) {
      const parts = [];
      if (envContext.profiles?.length) {
        parts.push('Available profiles and their native Claude Code tools:\n' +
          envContext.profiles.map(p => {
            const toolList = p.capabilities?.length ? p.capabilities.join(', ') : '(none)';
            return `  - "${p.name}": ${p.description || '(no description)'}\n    Native tools: ${toolList}`;
          }).join('\n'));
      }
      if (envContext.tools?.length) {
        parts.push('Available MCP tools (accessible to all steps via mcp__integrated__*):\n' +
          envContext.tools.map(t => `  - ${t.name}: ${t.description || ''}${t.params?.length ? ' — params: ' + t.params.map(p => `${p.name}(${p.type})`).join(', ') : ''}`).join('\n'));
      }
      if (envContext.workflows?.length) {
        parts.push('Other workflows (available as MCP tools by name):\n' +
          envContext.workflows.map(w => `  - ${w.name} → tool: ${w.name.replace(/-workflow$/, '').replace(/-/g, '_')}: ${w.description || ''}`).join('\n'));
      }
      if (parts.length) envSection = '\n\nEnvironment context:\n' + parts.join('\n\n') + '\n';
    }

    const toolName = workflow.name.replace(/-workflow$/, '').replace(/-/g, '_');

    const prompt = `You are a workflow compiler — an expert prompt engineer who transforms workflow definitions into executable JavaScript. The code you write is a vehicle for the prompts it produces. Your primary job is crafting buildPrompt functions that will be executed by autonomous AI agents in isolation.

## Source Workflow

\`\`\`json
${sourceContent}
\`\`\`
${envSection}
Write the compiled JavaScript module to: ${compiledPath}

## Execution Model — How Your Output Is Used at Runtime

Understanding this is essential. Each compiled step's buildPrompt(ctx) return value is piped as the SOLE input to an independent "claude -p" session:

1. **Complete isolation**: The agent has ZERO knowledge of the workflow — its name ("${workflow.name}"), its purpose, its steps, or that it's part of a workflow at all. The prompt text you generate is the agent's entire world.

2. **Full tool access**: The agent has access to ALL MCP tools listed in the environment context above, including this workflow's own tool ("${toolName}"). If the prompt reads like a request that matches a tool's description, the agent WILL call that tool instead of doing the work.

3. **Prompt-as-request**: The agent interprets the prompt as a user request. "Generate an analogy quiz about photosynthesis" will cause the agent to find and call "${toolName}" — triggering infinite recursion. The agent has no way to know it's already inside that workflow.

4. **No shared memory**: Each step runs in a fresh process. All context from previous steps must be embedded directly in the prompt via ctx.steps[id].output. The agent cannot look anything up.

## Tool Landscape — What Each Step Agent Has Access To

Each step's agent has TWO categories of tools. You must understand both to write effective prompts.

### Native Claude Code tools (determined by the step's profile)
Each step declares a "profile" that controls which native tools are available. Cross-reference the profile list above to know exactly what a step's agent can do. Key tools you need to know about:

- **AskUserQuestion** — The ONLY way to get interactive user input during a step. It presents a question to the user and returns their answer. When a step needs user input, the buildPrompt MUST explicitly say: "Use the AskUserQuestion tool to ask the user [question]." Without this explicit instruction, the agent may try to answer itself or call an MCP tool instead. Available in: safe, readonly, full (NOT minimal).
- **Read, Glob, Grep** — File system search and reading. Available in all profiles.
- **Write, Edit, Bash** — File writing and shell execution. Only available in "full" profile.
- **WebSearch, WebFetch** — Web access. Available in "safe" and "full" profiles.

### MCP tools (available to all steps)
All steps can call MCP tools listed in the environment context above via the mcp__integrated__* namespace. This includes workflow tools and custom tools. The agent sees each MCP tool with its name and description, and WILL call one if the prompt resembles a matching request.

### How to use this in your prompts
- **Name tools explicitly.** Don't say "ask the user" — say "Use the AskUserQuestion tool to ask the user...". Don't say "read the file" — say "Use the Read tool to read...". Explicit tool names prevent the agent from guessing or delegating to MCP tools.
- **Check the profile first.** Before instructing the agent to use a tool, verify the step's profile has it. Don't tell a "minimal" profile step to use AskUserQuestion — it doesn't have it.
- **Use disallowedTools for MCP tools the step should NOT call.** The profile controls native tools; disallowedTools controls MCP tools.

## Your Process — Analyze Before You Compile

Before writing any code, analyze each step in the source workflow. For each step, reason through:

1. **Workflow context preamble**: Every step's buildPrompt output MUST start with the mandatory preamble (see Principle 4 below). The only exception is if the step explicitly says it should re-invoke the workflow. Check each step's "do" text for this — if absent, the preamble is required.

2. **Prompt directiveness**: Will the buildPrompt output (after the preamble) read as a concrete work instruction or as a goal description? Goals cause tool-searching. Work instructions cause direct execution. Transform every goal into a work instruction.

3. **Other tool delegation risk**: Could the task be fulfilled by another available MCP tool listed above? Decide: should the step intentionally use that tool (legitimate delegation — mention it in the prompt), or should it do the work directly (the prompt must be specific enough that the agent doesn't go looking for tools)?

4. **Context completeness**: Does the prompt embed all data the agent needs from prior steps and inputs? Missing context forces the agent to guess or search.

## Prompt Engineering — The Core of Your Job

The prompts your buildPrompt functions produce determine whether the workflow succeeds or fails. These are not just task descriptions — they are the sole instructions for autonomous agents.

### Principle 1: Be directive and specific — tell the agent what to DO, not what to ACHIEVE

BAD: "The user wants an analogy quiz about ${"${topic}"}"
→ The agent thinks: "I have the ${toolName} tool — let me call that."
→ Result: infinite recursion.

GOOD: "You are a creative quiz designer. Given the topic ${"${topic}"} and the analogy ${"${analogy}"}, write a multiple-choice question with 4 options (A-D). The question should present a scenario entirely within the analogy domain, and the correct answer should reveal a truth about the original topic. Include: the scenario, the question, 4 labeled options, the correct answer letter, and a 2-sentence explanation mapping back to the topic."
→ The agent thinks: "I need to write this question myself."
→ Result: the agent does the work directly.

### Principle 2: Frame as concrete work, not goals

Goals trigger the agent's tool-searching behavior. Work instructions bypass it.

BAD: "Create a data visualization" → agent looks for viz tools
GOOD: "Write an HTML file with a D3.js bar chart. The data is: [data]. Use width 800, height 400. Include labeled axes and a title." → agent writes the code

BAD: "Explain this topic to the user" → agent may delegate to explain_topic tool
GOOD: "Write a clear, conversational explanation of [topic] using the [analogy] analogy. Map each key concept to a concrete element in the analogy. Structure: opening paragraph, concept mapping table, key takeaways." → agent writes the explanation

### Principle 3: Never echo the workflow's purpose as a request

The workflow's description is: "${workflow.description || ''}". If any step's prompt paraphrases this description, the agent will match it to the ${toolName} tool and call it. Instead, give the agent the specific decomposed sub-task with all data pre-loaded.

### Principle 4: MANDATORY workflow context preamble on every step

Every buildPrompt MUST begin its returned string with a workflow context block. This is not optional. The agent has no idea it's inside a workflow — you must tell it. This is the required structure:

"[Workflow context: you are executing step "{stepId}" of the "{workflow.name}" workflow. This workflow is exposed as the MCP tool "{toolName}". Do NOT call the {toolName} tool — you are already inside it. Complete your task directly.]

{rest of the directive prompt}"

This preamble goes on EVERY step. The agent receives nothing else — no system prompt, no memory, no workflow metadata. Without this preamble, ANY step can trigger recursion, because the agent sees topic-related context (from prior step outputs) and matches it to the ${toolName} tool.

The ONLY exception: if a step's "do" text explicitly says it should re-invoke this workflow (intentional recursion/iteration), omit the "Do NOT call" line for that step. This should be rare and always explicit in the source JSON.

### Principle 5: Inline all context

The agent has no access to the workflow's state. Every piece of data from prior steps must be embedded in the prompt text:
\`\`\`js
const topic = ctx.steps["gather-topic"].output;
const analogy = ctx.steps["find-analogy"].output;
return \`Given the topic: "${"${topic}"}"\nUsing this analogy:\n${"${analogy}"}\n\nWrite a question that...\`;
\`\`\`

### Principle 6: Name tools explicitly in the prompt

Don't leave tool usage to chance. If a step needs to ask the user something, write:
"Use the AskUserQuestion tool to ask the user: 'What topic would you like?'"

NOT just: "Ask the user what topic they want" — the agent may try to answer itself or delegate to an MCP tool.

Similarly: "Use the Read tool to read package.json" — not just "read package.json".

Always cross-reference the step's profile to confirm the tool is available before instructing the agent to use it.

## Module Structure

module.exports = {
  name: "${workflow.name}",
  description: ${JSON.stringify(workflow.description || '')},
  sourceHash: "${sourceHash}",
  annotations: {
    readOnlyHint: true/false,    // true only if ALL steps use "readonly" or "minimal" profiles
    destructiveHint: true/false, // true if ANY step uses "full" profile
    openWorldHint: true/false,   // true if ANY step uses "full" or "safe" profile
  },
  inputs: {
    // Map each input from the source JSON:
    // String "desc" → { type: "string", required: true, description: "desc" }
    // Object { type, description, required } → preserve exactly
  },
  steps: [
    {
      id: "step-name",
      profile: "profile-name" || null,
      type: "agent" || "condition",
      buildPrompt(ctx) { return "directive prompt string"; },  // agent steps
      parseOutput(raw) { return raw; },                        // extract structured data
      evaluate(ctx) { return true/false; },                    // condition steps
      next: "step-id" || null,
      then: "step-id" || null,   // condition true branch
      else: "step-id" || null,   // condition false branch
      maxRetries: N || undefined,
      parallel: ["step-id", ...] || null,  // fan-out step IDs
      join: "step-id" || null,             // fan-in target
      timeout: 60000 || null,              // ms
      onError: "step-id" || null,
      // Tool access control (IMPORTANT — enforced by runtime via CLI flags):
      disallowedTools: ["mcp__integrated__tool_name", ...] || null,  // tools the agent CANNOT call
    }
  ]
};

## Step Tool Access Control — Structural Recursion Prevention

Each step can declare a \`disallowedTools\` array. At runtime, these are passed as \`--disallowedTools\` CLI flags to the spawned agent — the agent physically cannot call these tools, regardless of what the prompt says.

This is CRITICAL for preventing self-invocation. The rules:

1. **Default: block the parent workflow tool on every step.** This workflow is registered as \`mcp__integrated__${toolName}\`. Every step MUST include \`disallowedTools: ["mcp__integrated__${toolName}"]\` unless the step is explicitly designed to re-invoke this workflow.

2. **Block other workflow tools where appropriate.** If a step should not delegate to other workflows listed in the environment context, add them to disallowedTools.

3. **This is your primary defense.** The runtime preamble and directive prompts are secondary. The disallowedTools field is the one thing that structurally guarantees the agent cannot recurse.

Example for a quiz-generator workflow:
\`\`\`js
{
  id: "generate-quiz",
  disallowedTools: ["mcp__integrated__analogy_quiz_generator"],  // can't call self
  // ...
}
\`\`\`

## Technical Rules

- Map inputs faithfully. Every input must appear in at least one buildPrompt as ctx.inputs.<key>.
- Access inputs via ctx.inputs.<key> — never hardcode values.
- If "do" text contains {{key}}, inject ctx.inputs.key at that position.
- Convert "do" into buildPrompt(ctx) — but remember, you're not just transcribing the "do" text. You're rewriting it as a high-quality directive prompt following the principles above.
- Convert "condition" into evaluate(ctx) — deterministic JS predicate, no AI call.
- Convert "produces" into parseOutput(raw) that extracts the expected shape.
- Wire data flow: if step B has context: ["A"], B's buildPrompt must reference ctx.steps.A.output.
- Preserve "parallel", "join", "timeout", "onError" fields exactly. Parallel steps have no buildPrompt.
- Steps array in execution order. Use the exact sourceHash provided.
- Profile capabilities for annotations:
  - "full": all tools (Bash, Write, Edit, Read, WebSearch, WebFetch) — destructive, open-world
  - "safe": no Bash/Write/Edit/NotebookEdit — open-world (web access)
  - "readonly": only Read, Glob, Grep, AskUserQuestion — read-only
  - "minimal": only Read, Glob, Grep — read-only
- Output rendering supports Markdown, MathJax ($...$ / $$...$$), fenced code blocks (\`\`\`html, \`\`\`svg, \`\`\`language), tables, and lists.
- You may structure the JS code however you like — helper functions, constants, shared strings, etc. The only requirement is the exported module shape above.`;

    const args = buildClaudeArgs(caps.loadProfile(PROJECT_ROOT, 'full'));
    const proc = spawnClaude(args, { cwd, proxyPort, profileName: 'full', instanceId: `wf-compile-${name}-${Date.now()}` });

    const compileTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 600000);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stderrBuf = '';
    const parser = createStreamJsonParser((event) => {
      if (event.type === 'content_block_delta' && event.delta?.text && broadcaster) {
        broadcaster.broadcast({ type: 'workflow:compile:progress', name, text: event.delta.text });
      }
    });

    proc.stdout.on('data', (chunk) => parser.write(chunk));
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });

    proc.on('close', (code) => {
      clearTimeout(compileTimeout);
      parser.flush();

      try {
        if (fs.existsSync(compiledPath)) {
          let compiledSource = fs.readFileSync(compiledPath, 'utf8');
          let needsWrite = false;

          // Patch sourceHash — the LLM may not copy the exact hash from the prompt
          const hashPatched = compiledSource.replace(
            /sourceHash:\s*["']([^"']+)["']/,
            `sourceHash: "${sourceHash}"`
          );
          if (hashPatched !== compiledSource) {
            compiledSource = hashPatched;
            needsWrite = true;
          }

          // Compute annotations from step profiles deterministically
          const profiles = Object.values(workflow.steps || {}).map(s => s.profile || 'full');
          const destructive = profiles.some(p => p === 'full');
          const readOnly = profiles.every(p => p === 'readonly' || p === 'minimal');
          const openWorld = profiles.some(p => p === 'full' || p === 'safe');
          const annotations = `{ readOnlyHint: ${readOnly}, destructiveHint: ${destructive}, openWorldHint: ${openWorld} }`;

          // Patch or insert annotations
          if (/annotations:\s*\{[^}]*\}/.test(compiledSource)) {
            const annPatched = compiledSource.replace(
              /annotations:\s*\{[^}]*\}/,
              `annotations: ${annotations}`
            );
            if (annPatched !== compiledSource) { compiledSource = annPatched; needsWrite = true; }
          } else {
            // Insert annotations after sourceHash line
            const annInserted = compiledSource.replace(
              /(sourceHash:\s*["'][^"']+["'],?\s*\n)/,
              `$1  annotations: ${annotations},\n`
            );
            if (annInserted !== compiledSource) { compiledSource = annInserted; needsWrite = true; }
          }

          if (needsWrite) fs.writeFileSync(compiledPath, compiledSource);
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

/**
 * Returns a map of profile name → [{ workflow, steps[] }] showing where each profile is used.
 */
function getProfileUsage(cwd) {
  const usage = {};
  for (const { name } of listWorkflows(cwd)) {
    const wf = loadWorkflow(cwd, name);
    if (!wf?.steps) continue;
    for (const [stepId, stepDef] of Object.entries(wf.steps)) {
      if (!stepDef.profile) continue;
      if (!usage[stepDef.profile]) usage[stepDef.profile] = [];
      const entry = usage[stepDef.profile].find(e => e.workflow === name);
      if (entry) entry.steps.push(stepId);
      else usage[stepDef.profile].push({ workflow: name, steps: [stepId] });
    }
  }
  return usage;
}

module.exports = {
  listWorkflows,
  loadWorkflow,
  loadCompiledSource,
  saveWorkflow,
  saveCompiledSource,
  renameWorkflow,
  deleteWorkflow,
  runWorkflow,
  cancelRun,
  getRunStatus,
  generateWorkflow,
  compileWorkflow,
  hashContent,
  getProfileUsage,
  activeRuns,
};
