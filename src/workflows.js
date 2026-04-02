// ============================================================
// Workflow Engine — CRUD + runtime for multi-step workflows
// Each step spawns a full claude -p session via ClaudeSessionManager
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const caps = require('./capabilities');
const { setQuestionContext, clearQuestionContext } = require('./proxy');
const { buildClaudeArgs, spawnClaude, createStreamJsonParser, ensureDir } = require('./utils');

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
            };
            const t0 = Date.now();
            try {
              const rawOutput = await executeStep(pStepId, prompt, execDef, {
                sessionManager, broadcaster, cwd,
                proxyPort, runId, tabId, dashboardPort, authToken,
              });
              const elapsed = Date.now() - t0;
              const parsed = safeCall(
                () => pCompiled?.parseOutput ? pCompiled.parseOutput(rawOutput) : rawOutput,
                rawOutput,
                `parseOutput failed for parallel step "${pStepId}"`
              );
              ctx.steps[pStepId] = { output: parsed };
              updateStepStatus(run, pStepId, 'done', broadcaster, runId, elapsed);
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
        };
        const stepStartTime = Date.now();

        try {
          const rawOutput = await executeStep(currentStepId, prompt, execDef, {
            sessionManager, broadcaster, cwd,
            proxyPort, runId, tabId, dashboardPort, authToken,
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
function executeStep(stepId, prompt, stepDef, { sessionManager, broadcaster, cwd, proxyPort, runId, tabId, dashboardPort, authToken }) {
  return new Promise((resolve, reject) => {
    const profile = (stepDef.profile && caps.loadProfile(PROJECT_ROOT, stepDef.profile)) || caps.loadActiveProfile(PROJECT_ROOT);
    const args = buildClaudeArgs(profile);

    if (tabId) setQuestionContext({ tabId, runId, stepId, profile: stepDef.profile || null });

    // Ensure hook reporters in spawn CWD
    const reporterPath = path.join(PROJECT_ROOT, 'lib', 'hook-reporter.js');
    caps.ensureHookReporters(cwd, reporterPath);

    const proc = spawnClaude(args, {
      cwd, proxyPort,
      profileName: profile.name || 'full',
      disableAutoMemory: profile.disableAutoMemory !== false,
      dashboardPort, authToken,
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
      if (tabId) clearQuestionContext();
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

function generateWorkflow(description, feedback, { proxyPort, cwd, envContext }) {
  return new Promise((resolve, reject) => {
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

    let prompt = `You are a workflow designer. Create a workflow JSON definition based on this description:

"${description}"

${feedback ? `Additional feedback from the user: "${feedback}"` : ''}${envSection}

Output ONLY valid JSON in this exact format (no markdown, no explanation):
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
      "do": "natural language instruction for this step",
      "produces": "description of expected output",
      "context": ["previous-step-ids"],
      "condition": "optional: natural language condition",
      "then": "step-if-true",
      "else": "step-if-false",
      "next": "explicit-next-step",
      "maxRetries": 3,
      "timeout": 120000,
      "onError": "error-handler-step"
    },
    "fan-out-step": {
      "parallel": ["step-a", "step-b", "step-c"],
      "join": "merge-step",
      "onError": "error-handler-step"
    }
  }
}

Rules:
- IMPORTANT: This workflow becomes an MCP tool. The "name" becomes the tool name (hyphens → underscores, "-workflow" suffix stripped, e.g., "analyze-code" → tool named "analyze_code"). The "description" becomes the tool description visible to the LLM.
- IMPORTANT: The "inputs" object defines the tool's typed parameters — they are what the caller passes when invoking the tool.
  - Each input key becomes a named parameter (e.g., "topic" → tool is called with { topic: "..." })
  - Use clear, descriptive parameter names like function arguments (e.g., "file_path", "language", "max_results") — avoid generic names like "input" or "data"
  - String value is shorthand for a required string param. Use object form { type, description, required } for non-string types or optional params.
  - Only define inputs the workflow truly needs from the caller. If a step gathers info interactively (via AskUserQuestion), that is NOT an input.
  - Steps reference inputs via {{key}} placeholders in their "do" text. Every defined input must be used by at least one step.
- IMPORTANT: Each step spawns a full Claude Code agent session (claude -p). A single step can perform complex multi-file operations, multi-turn reasoning, read/write files, run shell commands, search the web, spawn sub-agents, and more. Do NOT over-decompose — combine related work into fewer, more capable steps rather than splitting into many trivial ones.
- Each step's "do" field should be a clear, detailed instruction for the Claude Code agent that will execute it
- Use "context" to reference outputs from previous steps that this step needs
- Use "condition" for branching decisions
- The first step in the object is the entry point
- Steps execute in order unless overridden by "next", "then", or "else"
- Use "parallel" to fan out: the step has no "do", only a list of step IDs to run concurrently. Use "join" to specify where to converge after all parallel branches complete.
- Use "timeout" (milliseconds) on steps that may hang (e.g., long computations, web fetches)
- Use "onError" to redirect to a fallback step if the current step fails
- When a step needs user input or confirmation, instruct it to use the AskUserQuestion tool
- If a step can leverage an existing MCP tool (listed above), mention the tool by name in the "do" instruction
- If a step can delegate to another workflow, call it directly by its tool name (e.g., analyze_code)
- Match each step's profile to its requirements using the capabilities listed above:
  - Steps that write or edit files MUST use a profile with Write/Edit tools
  - Steps that run shell commands MUST use a profile with Bash
  - Steps that search the web MUST use a profile with WebSearch/WebFetch
  - Steps that only read/analyse code can use a read-only profile
- Only use profiles from the "Available profiles" list above
- Always include a final summary step`;

    const args = buildClaudeArgs(null);
    const proc = spawnClaude(args, { cwd, proxyPort, profileName: 'full' });

    const genTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 120000);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let result = null;
    let stderrBuf = '';
    const parser = createStreamJsonParser((event) => {
      if (event.type === 'result' && event.result) result = event.result;
    });

    proc.stdout.on('data', (chunk) => parser.write(chunk));
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });

    proc.on('close', (code) => {
      clearTimeout(genTimeout);
      parser.flush();

      if (!result) {
        const detail = stderrBuf.trim() ? `: ${stderrBuf.trim()}` : '';
        reject(new Error(`Generation produced no output (exit ${code})${detail}`));
        return;
      }

      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          resolve(JSON.parse(jsonMatch[0]));
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
        parts.push('Other workflows (available as MCP tools by name):\n' +
          envContext.workflows.map(w => `  - ${w.name} → tool: ${w.name.replace(/-workflow$/, '').replace(/-/g, '_')}: ${w.description || ''}`).join('\n'));
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
  description: ${JSON.stringify(workflow.description || '')},
  sourceHash: "${sourceHash}",
  annotations: {
    // MCP tool annotations — set based on what the workflow steps actually do:
    readOnlyHint: true/false,    // true if NO step can write files, edit, or run shell commands
    destructiveHint: true/false, // true if ANY step can modify files or run shell commands
    openWorldHint: true/false,   // true if ANY step can access the web (WebSearch, WebFetch)
  },
  inputs: {
    // Map each input from the source JSON faithfully:
    // If the source value is a string "desc": { type: "string", required: true, description: "desc" }
    // If the source value is an object { type, description, required }: preserve all fields exactly
    // key: { type: "string"|"number"|"boolean", required: true/false, description: "..." }
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
      // Parallel fan-out/fan-in (preserve from source JSON if present):
      parallel: ["step-id", ...] || null,  // list of step IDs to run concurrently
      join: "step-id" || null,             // step to proceed to after all parallel steps complete
      // Error handling (preserve from source JSON if present):
      timeout: 60000 || null,              // step-level timeout in ms
      onError: "step-id" || null,          // step to jump to on failure
    }
  ]
};

Rules:
- The "inputs" object defines MCP tool parameters. Map each source input faithfully:
  - If the source value is a string: { type: "string", required: true, description: <the string> }
  - If the source value is an object with type/description/required: preserve all fields exactly
  - Every input must appear in at least one step's buildPrompt(ctx) as ctx.inputs.<key>
- In buildPrompt(ctx), always access inputs via ctx.inputs.<key> — never hardcode input values
- If a step's "do" text contains {{key}}, the compiled buildPrompt must inject ctx.inputs.key at that position
- Convert "do" text into buildPrompt(ctx) that injects context from previous steps via ctx.steps[id].output
- Convert "condition" text into evaluate(ctx) JS predicate — deterministic, no AI call needed
- Convert "produces" into parseOutput(raw) that extracts the expected shape
- Wire data flow explicitly: if step B has context: ["A"], then B's buildPrompt must reference ctx.steps.A.output
- If the source JSON step has "parallel", "join", "timeout", or "onError" fields, preserve them exactly in the compiled output. Parallel steps dispatch child steps — they have no buildPrompt, only parallel/join/onError fields.
- The steps array must be in execution order
- Use the exact sourceHash provided
- Set the "annotations" object based on what the workflow's step profiles allow:
  - Examine each step's "profile" field. The builtin profiles and their capabilities are:
    - "full": all tools (Bash, Write, Edit, Read, WebSearch, WebFetch, etc.) — NOT read-only, IS destructive
    - "safe": no Bash/Write/Edit/NotebookEdit — may still search the web
    - "readonly": only Read, Glob, Grep, AskUserQuestion — IS read-only, NOT destructive
    - "minimal": only Read, Glob, Grep — IS read-only, NOT destructive
  - readOnlyHint: true only if ALL steps use "readonly" or "minimal" profiles (no step can modify anything)
  - destructiveHint: true if ANY step uses "full" profile (has Bash, Write, Edit access)
  - openWorldHint: true if ANY step uses "full" or "safe" profile (has potential web access)
- Output rendering supports full Markdown, MathJax ($...$ and $$...$$), and fenced code blocks. When a step produces visual output (diagrams, UI, formulas), use these formats:
  - Markdown tables, lists, headings for structured text
  - \`\`\`html for rendered HTML content (iframes, styled elements)
  - \`\`\`svg for inline SVG diagrams and charts
  - LaTeX math via $inline$ or $$display$$ for equations
  - Standard \`\`\`language for code snippets`;

    const args = buildClaudeArgs(null);
    const proc = spawnClaude(args, { cwd, proxyPort, profileName: 'full' });

    const compileTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 120000);

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
