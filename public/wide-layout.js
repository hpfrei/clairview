(function () {
  'use strict';

  const D3_CONST = {
    RULER_WIDTH: 52,
    COLUMN_WIDTH: 240,
    COLUMN_GAP: 16,
    MIN_ENTRY_HEIGHT: 52,
    TOOL_HEIGHT: 24,
    MIN_GAP: 6,
    HEADER_HEIGHT: 30,
    ZIGZAG_MIN_CUT: 10000,
  };

  const GAP_COLLAPSE_HEIGHT = 28;

  let _extractToolCalls = null;
  let _isStandardLlm = null;

  let _foldedHookIds = new Set();
  let _foldedHookParentInfo = new Map();

  let _clampedHookIds = new Set();
  let _clampedHookParentInfo = new Map();

  function init(deps) {
    _extractToolCalls = deps.extractToolCalls;
    _isStandardLlm = deps.isStandardLlm;
  }

  function extractToolCalls(interaction) {
    return _extractToolCalls(interaction);
  }

  function isStandardLlm(interaction) {
    return _isStandardLlm(interaction);
  }

  // --- Hook agent resolution ---

  function resolveHookAgentId(hookInteraction, interactions) {
    if (!hookInteraction.toolUseId) return null;
    for (let i = interactions.length - 1; i >= 0; i--) {
      const turn = interactions[i];
      if (turn.isHook || turn.isMcp) continue;
      if (turn.instanceId !== hookInteraction.instanceId) continue;
      const tools = extractToolCalls(turn);
      if (tools.some(tc => tc.id === hookInteraction.toolUseId)) {
        return turn.subagent?.agentId || null;
      }
    }
    return null;
  }

  function resolveClosedAgentId(hookInteraction, interactions, hookIdx, activeColumns) {
    const responseAgentId = hookInteraction.response?.body?.agentId
      || hookInteraction.request?.tool_response?.agentId;
    if (responseAgentId && activeColumns.has(responseAgentId)) {
      return responseAgentId;
    }

    if (hookInteraction.subagent?.agentId && activeColumns.has(hookInteraction.subagent.agentId)) {
      const candidateId = hookInteraction.subagent.agentId;
      let isLikelyChild = true;
      for (let j = hookIdx - 1; j >= 0; j--) {
        const prev = interactions[j];
        if (prev.isHook || prev.isMcp) continue;
        if (prev.subagent?.agentId === candidateId) {
          const tools = extractToolCalls(prev);
          if (tools.some(tc => tc.name === 'Agent' && tc.id === hookInteraction.toolUseId)) {
            isLikelyChild = false;
          }
          break;
        }
      }
      if (isLikelyChild) return candidateId;
    }

    const hookDesc = hookInteraction.request?.tool_input?.description;
    if (hookDesc) {
      for (let j = hookIdx - 1; j >= 0; j--) {
        const prev = interactions[j];
        const aid = prev.subagent?.agentId;
        if (aid && activeColumns.has(aid) && prev.subagent?.description === hookDesc) {
          return aid;
        }
      }
    }

    if (hookInteraction.toolUseId) {
      for (let j = hookIdx - 1; j >= 0; j--) {
        const prev = interactions[j];
        if (prev.isHook || prev.isMcp) continue;
        const tools = extractToolCalls(prev);
        const matchedTool = tools.find(tc => tc.id === hookInteraction.toolUseId);
        if (matchedTool) {
          const toolDesc = matchedTool.input?.description;
          if (toolDesc) {
            for (const [aid] of activeColumns) {
              for (let k = j + 1; k < hookIdx; k++) {
                const child = interactions[k];
                if (child.subagent?.agentId === aid && child.subagent?.description === toolDesc) {
                  return aid;
                }
              }
            }
          }
          break;
        }
      }
    }

    if (activeColumns.size === 1) {
      for (const [agentId] of activeColumns) return agentId;
    }
    return null;
  }

  // --- Column allocation ---

  function allocateColumn(freeColumns, activeColumns, nextColumnRef) {
    const activeCols = new Set(activeColumns.values());
    while (freeColumns.length > 0) {
      const col = freeColumns.pop();
      if (!activeCols.has(col)) return { col, nextColumn: nextColumnRef };
    }
    return { col: nextColumnRef, nextColumn: nextColumnRef + 1 };
  }

  // --- Folded hooks ---

  function buildFoldedHooksMap(interactions) {
    // Clear stale annotations from previous render
    for (const interaction of interactions) {
      if (interaction._foldedPreHooks) delete interaction._foldedPreHooks;
    }

    const toolUseToParent = new Map();
    for (const interaction of interactions) {
      if (interaction.isHook || interaction.isMcp) continue;
      for (const tc of extractToolCalls(interaction)) {
        if (tc.id) toolUseToParent.set(tc.id, interaction);
      }
    }
    const foldedIds = new Set();
    const parentHooks = new Map();
    const hookParentInfo = new Map();
    for (const interaction of interactions) {
      if (!interaction.isHook || !/PreToolUse/i.test(interaction.hookEvent) || interaction.toolName !== 'Agent') continue;
      const parent = interaction.toolUseId ? toolUseToParent.get(interaction.toolUseId) : null;
      if (!parent) continue;
      foldedIds.add(interaction.id);
      if (!parentHooks.has(parent.id)) parentHooks.set(parent.id, []);
      const hooks = parentHooks.get(parent.id);
      hookParentInfo.set(interaction.id, { parentId: parent.id, hookIndex: hooks.length });
      hooks.push(interaction);
    }
    for (const [pid, hooks] of parentHooks) {
      const p = interactions.find(i => i.id === pid);
      if (p) p._foldedPreHooks = hooks;
    }
    _foldedHookIds = foldedIds;
    _foldedHookParentInfo = hookParentInfo;
    return { foldedIds, hookParentInfo };
  }

  // --- Clamped hooks: collapse rapid PreToolUse/PostToolUse/PostToolBatch into anchor LLM turn ---

  function buildClampGroups(interactions, columnFor) {
    const CLAMP_WINDOW = 5000;
    const CLAMP_EVENTS = /^(PreToolUse|PostToolUse|PostToolBatch|PostToolUseFailure|TaskCreated|TaskCompleted)$/i;

    for (const interaction of interactions) {
      if (interaction._clampedHooks) delete interaction._clampedHooks;
    }

    const clampedIds = new Set();
    const clampParentInfo = new Map();

    for (let i = 0; i < interactions.length; i++) {
      const anchor = interactions[i];
      if (anchor.isHook || anchor.isMcp || !isStandardLlm(anchor)) continue;
      const tools = extractToolCalls(anchor);
      if (tools.length === 0) continue;

      const anchorCol = columnFor.get(anchor.id) || 0;
      const anchorEndTs = anchor.timestamp + (anchor.timing?.duration || 0);
      const group = [];

      for (let j = i + 1; j < interactions.length; j++) {
        const candidate = interactions[j];
        if (!candidate.isHook) break;
        if (_foldedHookIds.has(candidate.id)) continue;
        if (!CLAMP_EVENTS.test(candidate.hookEvent)) break;
        if (candidate.toolName === 'Agent') continue;
        const candCol = columnFor.get(candidate.id) || 0;
        if (candCol !== anchorCol) continue;
        if (candidate.timestamp - anchorEndTs > CLAMP_WINDOW) break;
        group.push(candidate);
      }

      if (group.length === 0) continue;

      anchor._clampedHooks = group;
      for (let k = 0; k < group.length; k++) {
        clampedIds.add(group[k].id);
        clampParentInfo.set(group[k].id, { parentId: anchor.id, hookIndex: k });
      }
    }

    _clampedHookIds = clampedIds;
    _clampedHookParentInfo = clampParentInfo;
    return { clampedIds, clampParentInfo };
  }

  // --- Column assignment ---

  function buildColumnAssignment(interactions, registerSubagentFn) {
    const columnFor = new Map();
    const activeColumns = new Map();
    const historicalColumns = new Map();
    const columnAgents = new Map();
    const freeColumns = [];
    const parallelRegions = [];
    const postHookClosedCol = new Map();
    const columnSegments = [];
    const activeSegments = new Map();
    const pendingPreHooks = [];
    const depthAt = new Array(interactions.length);
    let nextColumn = 1;
    let currentRegion = null;

    // Pre-scan: find the last interaction index for each agentId.
    // Checks subagent.agentId on enriched interactions AND hookAgentId on
    // SubagentStart/SubagentStop hooks (which carry agent_id directly).
    const agentLastIdx = new Map();
    for (let i = 0; i < interactions.length; i++) {
      const aid = interactions[i].subagent?.agentId
        || (interactions[i].isHook && interactions[i].hookAgentId) || null;
      if (aid) agentLastIdx.set(aid, i);
    }

    // Pre-scan: collect PostToolUse/Agent hooks for segment matching after the main loop.
    const postAgentHooks = [];
    // Pre-scan: collect SubagentStop hooks for segment matching (merge arrows).
    const subagentStopHooks = [];
    for (let i = 0; i < interactions.length; i++) {
      const int = interactions[i];
      if (int.isHook && /PostToolUse/i.test(int.hookEvent) && int.toolName === 'Agent') {
        postAgentHooks.push({ id: int.id, idx: i, toolUseId: int.toolUseId, description: int.request?.tool_input?.description });
      }
      if (int.isHook && int.hookEvent === 'SubagentStop' && int.subagent?.agentId) {
        subagentStopHooks.push({ id: int.id, idx: i, agentId: int.subagent.agentId });
      }
    }

    // Pre-scan: detect Agent tool calls in LLM turns to enable eager column
    // creation before JSONL enrichment arrives.  Builds a mapping from
    // description → agentId for cases where SubagentStart hooks or enriched
    // child interactions provide the real ID, and falls back to a synthetic
    // ID ("pending-<toolUseId>") otherwise.
    const descToAgentId = new Map();
    for (let i = 0; i < interactions.length; i++) {
      const int = interactions[i];
      if (int.subagent?.agentId && int.subagent.description) {
        descToAgentId.set(int.subagent.description, int.subagent.agentId);
      }
    }
    const agentToolCalls = [];
    for (let i = 0; i < interactions.length; i++) {
      const int = interactions[i];
      if (int.isHook || int.isMcp) continue;
      const tools = extractToolCalls(int);
      for (const tc of tools) {
        if (tc.name !== 'Agent' || !tc.id) continue;
        const desc = tc.input?.description || null;
        const realId = desc ? descToAgentId.get(desc) : null;
        const agentId = realId || ('pending-' + tc.id);
        if (!agentLastIdx.has(agentId) && desc) {
          agentLastIdx.set(agentId, i);
        }
        agentToolCalls.push({ toolUseId: tc.id, description: desc, agentId, parentIdx: i, isSynthetic: !realId });
      }
    }
    const toolUseToEagerAgent = new Map();
    for (const atc of agentToolCalls) {
      toolUseToEagerAgent.set(atc.toolUseId, atc);
    }

    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      let agentId = null;
      if (interaction.isHook) {
        agentId = interaction.subagent?.agentId || interaction.hookAgentId
          || resolveHookAgentId(interaction, interactions.slice(0, idx));
      } else {
        agentId = interaction.subagent?.agentId || null;
      }

      if (interaction.isHook && interaction.hookEvent && /PreToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
        pendingPreHooks.push({ id: interaction.id, toolUseId: interaction.toolUseId, description: interaction.request?.tool_input?.description });
      }

      // Eager column creation: when this LLM turn contains Agent tool calls
      // but no enrichment has arrived yet, create columns from the pre-scanned
      // agentToolCalls mapping so subagent lanes appear immediately.
      if (!interaction.isHook && !interaction.isMcp && !agentId) {
        const tools = extractToolCalls(interaction);
        for (const tc of tools) {
          if (tc.name !== 'Agent' || !tc.id) continue;
          const eager = toolUseToEagerAgent.get(tc.id);
          if (!eager) continue;
          const eagerAid = eager.agentId;
          if (activeColumns.has(eagerAid) || historicalColumns.has(eagerAid)) continue;
          const alloc = allocateColumn(freeColumns, activeColumns, nextColumn);
          nextColumn = alloc.nextColumn;
          activeColumns.set(eagerAid, alloc.col);
          historicalColumns.set(eagerAid, alloc.col);
          const synSub = { agentId: eagerAid, agentType: 'agent', description: eager.description };
          if (registerSubagentFn) registerSubagentFn(synSub);
          columnAgents.set(alloc.col, synSub);
          let startHookId = null;
          if (eager.description && pendingPreHooks.length > 0) {
            const mi = pendingPreHooks.findIndex(ph => ph.description === eager.description);
            if (mi >= 0) { startHookId = pendingPreHooks[mi].id; pendingPreHooks.splice(mi, 1); }
          }
          if (!startHookId && pendingPreHooks.length === 1) {
            startHookId = pendingPreHooks[0].id; pendingPreHooks.splice(0, 1);
          }
          columnSegments.push({ col: alloc.col, agentId: eagerAid, subagent: synSub, startIdx: idx, endHookId: null, startHookId });
          activeSegments.set(eagerAid, columnSegments[columnSegments.length - 1]);
        }
      }

      // SubagentStop must never open a new column — only close existing ones
      if (interaction.isHook && interaction.hookEvent === 'SubagentStop'
          && agentId && !activeColumns.has(agentId) && !historicalColumns.has(agentId)) {
        agentId = null;
      }

      if (agentId && !activeColumns.has(agentId) && !historicalColumns.has(agentId)) {
        const alloc = allocateColumn(freeColumns, activeColumns, nextColumn);
        const col = alloc.col;
        nextColumn = alloc.nextColumn;
        activeColumns.set(agentId, col);
        historicalColumns.set(agentId, col);
        if (interaction.subagent) {
          if (registerSubagentFn) registerSubagentFn(interaction.subagent);
          columnAgents.set(col, interaction.subagent);
        }
        let startHookId = null;
        const subDesc = interaction.subagent?.description;
        if (subDesc && pendingPreHooks.length > 0) {
          const matchIdx = pendingPreHooks.findIndex(ph => ph.description === subDesc);
          if (matchIdx >= 0) {
            startHookId = pendingPreHooks[matchIdx].id;
            pendingPreHooks.splice(matchIdx, 1);
          }
        }
        if (!startHookId && pendingPreHooks.length === 1) {
          startHookId = pendingPreHooks[0].id;
          pendingPreHooks.splice(0, 1);
        }
        const seg = { col, agentId, subagent: interaction.subagent, startIdx: idx, endHookId: null, startHookId };
        columnSegments.push(seg);
        activeSegments.set(agentId, seg);
      }

      const resolvedCol = agentId
        ? (activeColumns.get(agentId) || historicalColumns.get(agentId) || 0)
        : 0;
      if (resolvedCol > 0 && interaction.subagent) {
        const existing = columnAgents.get(resolvedCol);
        if (!existing || (existing.agentType === 'agent' && interaction.subagent.agentType && interaction.subagent.agentType !== 'agent')) {
          if (registerSubagentFn) registerSubagentFn(interaction.subagent);
          columnAgents.set(resolvedCol, interaction.subagent);
          const seg = activeSegments.get(agentId);
          if (seg) seg.subagent = interaction.subagent;
        }
      }
      // PostToolUse/Agent hooks always go to column 0 (main thread)
      const assignedCol = (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent')
        ? 0 : resolvedCol;
      columnFor.set(interaction.id, assignedCol);

      // Free columns when we pass the agent's last interaction (not on PostToolUse hooks)
      if (agentId && activeColumns.has(agentId) && agentLastIdx.get(agentId) === idx) {
        const closedCol = activeColumns.get(agentId);
        const seg = activeSegments.get(agentId);
        if (seg) activeSegments.delete(agentId);
        freeColumns.push(closedCol);
        activeColumns.delete(agentId);
      }

      depthAt[idx] = activeColumns.size;

      const inParallel = activeColumns.size > 0;
      if (inParallel && !currentRegion) {
        currentRegion = { startIdx: idx, endIdx: idx, startTime: interaction.timestamp, endTime: interaction.timestamp };
      } else if (inParallel && currentRegion) {
        currentRegion.endIdx = idx;
        currentRegion.endTime = interaction.timestamp;
      } else if (!inParallel && currentRegion) {
        currentRegion.endIdx = idx;
        currentRegion.endTime = interaction.timestamp;
        parallelRegions.push(currentRegion);
        currentRegion = null;
      }
    }
    if (currentRegion) parallelRegions.push(currentRegion);

    // Match remaining PreToolUse/Agent hooks to segments that missed them during
    // eager column creation (PreToolUse hooks arrive after the LLM turn that spawned them).
    for (const ph of pendingPreHooks) {
      const eager = toolUseToEagerAgent.get(ph.toolUseId);
      if (eager) {
        const seg = columnSegments.find(s => s.agentId === eager.agentId && !s.startHookId);
        if (seg) { seg.startHookId = ph.id; continue; }
      }
      if (ph.description) {
        const seg = columnSegments.find(s => !s.startHookId && s.subagent?.description === ph.description);
        if (seg) seg.startHookId = ph.id;
      }
    }

    // Match PostToolUse/Agent hooks to segments by description for merge arrows.
    // These hooks fire at launch time and have agentId=null, so we match by
    // the description field (e.g. "Sleep 1 second") against segment subagent descriptions.
    for (const ph of postAgentHooks) {
      let matched = false;
      if (ph.description) {
        for (const seg of columnSegments) {
          if (seg.endHookId) continue;
          if (seg.subagent?.description === ph.description) {
            seg.endHookId = ph.id;
            postHookClosedCol.set(ph.id, seg.col);
            matched = true;
            break;
          }
        }
      }
      if (!matched && ph.toolUseId) {
        for (let j = ph.idx - 1; j >= 0; j--) {
          const prev = interactions[j];
          if (prev.isHook || prev.isMcp) continue;
          const tools = extractToolCalls(prev);
          const matchedTool = tools.find(tc => tc.id === ph.toolUseId);
          if (matchedTool) {
            const toolDesc = matchedTool.input?.description;
            if (toolDesc) {
              for (const seg of columnSegments) {
                if (seg.endHookId) continue;
                if (seg.subagent?.description === toolDesc) {
                  seg.endHookId = ph.id;
                  postHookClosedCol.set(ph.id, seg.col);
                  matched = true;
                  break;
                }
              }
            }
            break;
          }
        }
      }
      if (!matched) {
        const unclosed = columnSegments.filter(s => !s.endHookId);
        if (unclosed.length === 1) {
          unclosed[0].endHookId = ph.id;
          postHookClosedCol.set(ph.id, unclosed[0].col);
        }
      }
    }

    // Match SubagentStop hooks to segments by agentId for merge arrows.
    for (const sh of subagentStopHooks) {
      for (const seg of columnSegments) {
        if (seg.endHookId) continue;
        if (seg.agentId === sh.agentId) {
          seg.endHookId = sh.id;
          postHookClosedCol.set(sh.id, seg.col);
          break;
        }
      }
    }

    return { columnFor, totalColumns: nextColumn, columnAgents, activeColumns, historicalColumns, freeColumns, nextColumn, parallelRegions, postHookClosedCol, columnSegments, depthAt };
  }

  // --- Node height ---

  function computeNodeHeight(interaction) {
    if (interaction.isHook) return 28;
    if (!isStandardLlm(interaction)) return 28;
    if (interaction.isMcp) return 42;
    const tools = extractToolCalls(interaction);
    const foldedCount = interaction._foldedPreHooks?.length || 0;
    const clampedCount = interaction._clampedHooks?.length || 0;
    const clampedRows = clampedCount > 2 ? 1 : clampedCount;
    const clampedPad = clampedCount > 0 ? 4 : 0;
    return D3_CONST.MIN_ENTRY_HEIGHT + (tools.length + foldedCount + clampedRows) * D3_CONST.TOOL_HEIGHT + clampedPad;
  }

  // --- Column width ---

  function computeColumnWidth(_totalColumns) {
    return D3_CONST.COLUMN_WIDTH;
  }

  // --- Main layout pass ---

  function computeD3Layout(interactions, columnFor, totalColumns, parallelRegions, postHookClosedCol, _depthAt) {
    const C = D3_CONST;
    const layout = [];
    const breaks = [];
    const colBottoms = new Map();
    const sessionStart = interactions.length > 0 ? interactions[0].timestamp : 0;
    let globalBottom = C.HEADER_HEIGHT + 8;
    const availWidth = computeColumnWidth(totalColumns);

    let prevElapsed = null;

    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      const elapsed = interaction.timestamp - sessionStart;

      if (_foldedHookIds.has(interaction.id) || _clampedHookIds.has(interaction.id)) {
        layout.push({ id: interaction.id, x: 0, y: 0, width: 0, height: 0, col: 0, interaction, elapsed, idx });
        continue;
      }

      const col = columnFor.get(interaction.id) || 0;
      const height = computeNodeHeight(interaction);
      const x = C.RULER_WIDTH + col * (availWidth + C.COLUMN_GAP);

      // Gap compression: zigzag break for long pauses
      if (prevElapsed != null && (elapsed - prevElapsed) > C.ZIGZAG_MIN_CUT) {
        const breakY = globalBottom + C.MIN_GAP + GAP_COLLAPSE_HEIGHT / 2;
        breaks.push({ y: breakY, elapsedBefore: prevElapsed, elapsedAfter: elapsed });
        globalBottom = breakY + GAP_COLLAPSE_HEIGHT / 2;
        for (const [k, v] of colBottoms) {
          if (v < globalBottom) colBottoms.set(k, globalBottom);
        }
      }

      // Sequential placement: respect both global timestamp order and column bottom
      const colBottom = colBottoms.get(col) || globalBottom;
      let y = Math.max(globalBottom, colBottom) + C.MIN_GAP;

      // For merge-point hooks (PostToolUse/Agent), also respect the closed column bottom
      if (postHookClosedCol) {
        const closedCol = postHookClosedCol.get(interaction.id);
        if (closedCol != null && colBottoms.has(closedCol)) {
          y = Math.max(y, colBottoms.get(closedCol) + C.MIN_GAP);
        }
      }

      const entryBottom = y + height;
      layout.push({ id: interaction.id, x, y, width: availWidth, height, col, interaction, elapsed, idx, timeBottom: entryBottom });
      colBottoms.set(col, entryBottom);
      if (entryBottom > globalBottom) globalBottom = entryBottom;
      prevElapsed = elapsed;
    }

    // Monotonic elapsed→Y interpolation for ruler and connectors
    const yPoints = layout.filter(item => item.height > 0).map(item => ({ elapsed: item.elapsed, y: item.y }));
    for (let i = 1; i < yPoints.length; i++) {
      if (yPoints[i].y < yPoints[i - 1].y) yPoints[i].y = yPoints[i - 1].y;
    }
    function elapsedToY(t) {
      if (yPoints.length === 0) return C.HEADER_HEIGHT + 8;
      if (t <= yPoints[0].elapsed) return yPoints[0].y;
      if (t >= yPoints[yPoints.length - 1].elapsed) return yPoints[yPoints.length - 1].y;
      for (let i = 0; i < yPoints.length - 1; i++) {
        if (yPoints[i].elapsed <= t && t <= yPoints[i + 1].elapsed) {
          const dt = yPoints[i + 1].elapsed - yPoints[i].elapsed;
          if (dt === 0) return yPoints[i].y;
          const frac = (t - yPoints[i].elapsed) / dt;
          return yPoints[i].y + frac * (yPoints[i + 1].y - yPoints[i].y);
        }
      }
      return yPoints[yPoints.length - 1].y;
    }

    let finalBottom = C.HEADER_HEIGHT + 8;
    for (const item of layout) {
      if (item.y + item.height > finalBottom) finalBottom = item.y + item.height;
    }

    return { layout, totalHeight: finalBottom + 40, sessionStart, breaks, compressedY: elapsedToY };
  }

  // --- Connector data (fork/merge arrows, bgRects) ---

  function computeConnectorData(layout, columnFor, columnAgents, totalColumns, elapsedToY, sessionStart, postHookClosedCol, columnSegments, opts) {
    const SUBAGENT_COLORS = opts?.subagentColors || ['#6366f1'];
    const getSubagentColor = opts?.getSubagentColor || (() => SUBAGENT_COLORS[0]);
    const connectors = [];
    const colWidth = computeColumnWidth(totalColumns);

    const layoutById = new Map();
    const colEntries = new Map();
    for (const item of layout) {
      layoutById.set(item.id, item);
      if (!colEntries.has(item.col)) colEntries.set(item.col, []);
      colEntries.get(item.col).push(item);
    }
    const mainEntries = (colEntries.get(0) || []).filter(item => !_foldedHookIds.has(item.id) && !_clampedHookIds.has(item.id));

    const hookEntryById = new Map();
    for (const me of mainEntries) hookEntryById.set(me.id, me);

    if (columnSegments && columnSegments.length > 0) {
      for (const seg of columnSegments) {
        const entries = (colEntries.get(seg.col) || []).filter(item => {
          const aid = item.interaction.subagent?.agentId;
          return aid === seg.agentId;
        });
        if (entries.length === 0) continue;

        const color = seg.subagent ? getSubagentColor(seg.subagent) : SUBAGENT_COLORS[0];
        const bgLeft = D3_CONST.RULER_WIDTH + seg.col * (colWidth + D3_CONST.COLUMN_GAP) - 4;
        const bgTop = entries[0].y - 4;
        const lastEntry = entries[entries.length - 1];

        const bgBottom = (lastEntry.timeBottom || (lastEntry.y + computeNodeHeight(lastEntry.interaction))) + 4;
        const hookEntry = seg.endHookId ? hookEntryById.get(seg.endHookId) : null;

        // Fork arrow
        let forkOriginY = bgTop;
        let forkOriginX = D3_CONST.RULER_WIDTH + colWidth / 2;
        const startHookEntry = seg.startHookId ? hookEntryById.get(seg.startHookId) : null;
        if (startHookEntry) {
          forkOriginY = startHookEntry.y + startHookEntry.height / 2;
          forkOriginX = startHookEntry.x + startHookEntry.width / 2;
        } else if (seg.startHookId && _foldedHookIds.has(seg.startHookId)) {
          const info = _foldedHookParentInfo.get(seg.startHookId);
          if (info) {
            const parentItem = layoutById.get(info.parentId);
            if (parentItem) {
              const tools = extractToolCalls(parentItem.interaction);
              forkOriginY = parentItem.y + D3_CONST.MIN_ENTRY_HEIGHT
                + tools.length * D3_CONST.TOOL_HEIGHT
                + info.hookIndex * D3_CONST.TOOL_HEIGHT
                + D3_CONST.TOOL_HEIGHT / 2;
              forkOriginX = parentItem.x + parentItem.width / 2;
            }
          }
        } else {
          for (let i = mainEntries.length - 1; i >= 0; i--) {
            if (mainEntries[i].y <= entries[0].y) {
              forkOriginY = mainEntries[i].y + mainEntries[i].height / 2;
              forkOriginX = mainEntries[i].x + mainEntries[i].width / 2;
              break;
            }
          }
        }

        // Fork: arc upward, ending at center of subagent top border
        const forkTargetX = bgLeft + (colWidth + 8) / 2;
        const forkBow = Math.max(20, Math.abs(forkTargetX - forkOriginX) * 0.2);
        const forkTopY = Math.min(forkOriginY, bgTop) - forkBow;
        connectors.push({
          type: 'fork', col: seg.col,
          path: `M${forkOriginX},${forkOriginY} C${forkOriginX},${forkTopY} ${forkTargetX},${forkTopY} ${forkTargetX},${bgTop}`,
          color, opacity: 0.6, strokeWidth: 2.5, agentId: seg.agentId,
        });

        // Merge arrow: from bgBottom to the matching PostToolUse/Agent hook
        let mergeTargetY = null;
        let mergeTargetX = D3_CONST.RULER_WIDTH + colWidth / 2;
        if (hookEntry) {
          mergeTargetY = hookEntry.y + hookEntry.height / 2;
          mergeTargetX = hookEntry.x + hookEntry.width / 2;
        } else {
          for (const me of mainEntries) {
            if (me.y >= bgBottom - 4) {
              mergeTargetY = me.y + me.height / 2;
              mergeTargetX = me.x + me.width / 2;
              break;
            }
          }
        }
        if (mergeTargetY != null) {
          const bgCenterX = bgLeft + (colWidth + 8) / 2;
          // Merge: arc downward (control points below both endpoints)
          const mergeBow = Math.max(20, Math.abs(bgCenterX - mergeTargetX) * 0.2);
          const mergeBotY = Math.max(bgBottom, mergeTargetY) + mergeBow;
          connectors.push({
            type: 'merge', col: seg.col,
            path: `M${bgCenterX},${bgBottom} C${bgCenterX},${mergeBotY} ${mergeTargetX},${mergeBotY} ${mergeTargetX},${mergeTargetY}`,
            color, opacity: 0.6, strokeWidth: 2.5, agentId: seg.agentId,
          });
        }

        connectors.push({
          type: 'bgRect', col: seg.col,
          x: bgLeft, y: bgTop, width: colWidth + 8, height: bgBottom - bgTop,
          color, agentId: seg.agentId,
          isStreaming: entries.some(e => e.interaction.status === 'streaming'),
        });
      }
    } else {
      // Legacy fallback without segments
      for (let col = 1; col < totalColumns; col++) {
        const entries = colEntries.get(col);
        if (!entries || entries.length === 0) continue;
        const agent = columnAgents.get(col);
        const color = agent ? getSubagentColor(agent) : SUBAGENT_COLORS[0];
        const bgLeft = D3_CONST.RULER_WIDTH + col * (colWidth + D3_CONST.COLUMN_GAP) - 4;
        const bgTop = entries[0].y - 4;
        const lastEntry = entries[entries.length - 1];
        const bgBottom = (lastEntry.timeBottom || (lastEntry.y + computeNodeHeight(lastEntry.interaction))) + 4;

        connectors.push({
          type: 'bgRect', col,
          x: bgLeft, y: bgTop, width: colWidth + 8, height: bgBottom - bgTop,
          color, agentId: agent?.agentId,
          isStreaming: entries.some(e => e.interaction.status === 'streaming'),
        });

        let forkOriginY = bgTop;
        let forkOriginX = D3_CONST.RULER_WIDTH + colWidth / 2;
        for (let i = mainEntries.length - 1; i >= 0; i--) {
          if (mainEntries[i].y <= entries[0].y) {
            forkOriginY = mainEntries[i].y + mainEntries[i].height / 2;
            forkOriginX = mainEntries[i].x + mainEntries[i].width / 2;
            break;
          }
        }
        const legacyTargetX = bgLeft + (colWidth + 8) / 2;
        const legacyBow = Math.max(20, Math.abs(legacyTargetX - forkOriginX) * 0.2);
        const legacyTopY = Math.min(forkOriginY, bgTop) - legacyBow;
        connectors.push({
          type: 'fork', col,
          path: `M${forkOriginX},${forkOriginY} C${forkOriginX},${legacyTopY} ${legacyTargetX},${legacyTopY} ${legacyTargetX},${bgTop}`,
          color, opacity: 0.6, strokeWidth: 2.5, agentId: agent?.agentId,
        });
      }
    }

    return connectors;
  }

  // --- Public API ---

  function isFoldedHook(id) {
    return _foldedHookIds.has(id);
  }

  function getFoldedHookParentInfo(id) {
    return _foldedHookParentInfo.get(id);
  }

  function isClampedHook(id) {
    return _clampedHookIds.has(id);
  }

  function getClampedHookParentInfo(id) {
    return _clampedHookParentInfo.get(id);
  }

  window.wideLayout = {
    init,
    D3_CONST,
    resolveHookAgentId,
    resolveClosedAgentId,
    allocateColumn,
    buildFoldedHooksMap,
    buildClampGroups,
    buildColumnAssignment,
    computeNodeHeight,
    computeColumnWidth,
    computeD3Layout,
    computeConnectorData,
    isFoldedHook,
    getFoldedHookParentInfo,
    isClampedHook,
    getClampedHookParentInfo,
  };
})();
