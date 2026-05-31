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
    COHORT_EPSILON_MS: 300,
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


  // --- Column allocation ---

  function allocateColumn(freeColumns, activeColumns, nextColumnRef) {
    const activeCols = new Set(activeColumns.values());
    freeColumns.sort((a, b) => b - a);
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
      const toolUseIds = new Set(tools.map(tc => tc.id).filter(Boolean));
      const group = [];

      // Backward scan: hooks delivered before this turn but belonging to it (by toolUseId).
      // Non-standard LLM entries (count_tokens) are also clampable.
      // In parallel columns, entries from other columns are interleaved — only
      // break on same-column boundaries so clamping works independently per column.
      for (let j = i - 1; j >= 0; j--) {
        const candidate = interactions[j];
        const candCol = columnFor.get(candidate.id) || 0;
        if (!candidate.isHook) {
          if (!candidate.isMcp && !isStandardLlm(candidate)) {
            if (candCol !== anchorCol) continue;
            if (clampedIds.has(candidate.id)) continue;
            group.unshift(candidate);
            continue;
          }
          if (candCol === anchorCol) break;
          continue;
        }
        if (!CLAMP_EVENTS.test(candidate.hookEvent)) continue;
        if (_foldedHookIds.has(candidate.id) || clampedIds.has(candidate.id)) continue;
        if (candidate.toolName === 'Agent') continue;
        if (candCol !== anchorCol) continue;
        if (!candidate.toolUseId || !toolUseIds.has(candidate.toolUseId)) continue;
        group.unshift(candidate);
      }

      // Forward scan: hooks after this turn within the clamp window.
      // Non-standard LLM entries (count_tokens) are also clampable.
      // Same column-aware logic: skip entries from other columns so interleaved
      // parallel interactions don't break the scan.
      for (let j = i + 1; j < interactions.length; j++) {
        const candidate = interactions[j];
        const candCol = columnFor.get(candidate.id) || 0;
        if (!candidate.isHook) {
          if (!candidate.isMcp && !isStandardLlm(candidate)) {
            if (candCol !== anchorCol) continue;
            if (candidate.timestamp - anchorEndTs > CLAMP_WINDOW) break;
            group.push(candidate);
            continue;
          }
          if (candCol === anchorCol) break;
          continue;
        }
        if (_foldedHookIds.has(candidate.id)) continue;
        if (!CLAMP_EVENTS.test(candidate.hookEvent)) {
          if (candCol === anchorCol) break;
          continue;
        }
        if (candidate.toolName === 'Agent') continue;
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

  // --- Subagent attribution by spawning-prompt match ---

  // The prompt a parent passes to an Agent tool call appears verbatim in that
  // subagent's own request messages. This uniquely identifies a subagent turn —
  // even among identical concurrent agents — when server-side enrichment hasn't
  // (yet) stamped subagent.agentId.

  function normWhitespace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function turnUserText(interaction) {
    const msgs = interaction.request?.messages;
    if (!Array.isArray(msgs)) return '';
    const parts = [];
    for (const m of msgs) {
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') parts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === 'text' && b.text) parts.push(b.text);
      }
    }
    return normWhitespace(parts.join('\n'));
  }

  // --- Column assignment ---

  function buildColumnAssignment(interactions, registerSubagentFn) {
    // Clear inferred subagent assignments from previous renders so they don't
    // pollute the agentLastIdx pre-scan or hook resolution on re-render.
    for (const interaction of interactions) {
      if (interaction._subagentInferred) {
        delete interaction.subagent;
        delete interaction._subagentInferred;
      }
    }

    const columnFor = new Map();
    const activeColumns = new Map();
    const historicalColumns = new Map();
    const columnAgents = new Map();
    const freeColumns = [];
    const parallelRegions = [];
    const postHookClosedCol = new Map();
    const columnSegments = [];
    const activeSegments = new Map();
    const startToolUseToSeg = new Map();
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

    const agentToolCalls = [];
    for (let i = 0; i < interactions.length; i++) {
      const int = interactions[i];
      if (int.isHook || int.isMcp) continue;
      const tools = extractToolCalls(int);
      for (const tc of tools) {
        if (tc.name !== 'Agent' || !tc.id) continue;
        const desc = tc.input?.description || null;
        const agentId = 'pending-' + tc.id;
        if (!agentLastIdx.has(agentId) && desc) {
          agentLastIdx.set(agentId, i);
        }
        const probe = normWhitespace(tc.input?.prompt).slice(0, 200);
        agentToolCalls.push({ toolUseId: tc.id, description: desc, agentId, parentIdx: i, subagentType: tc.input?.subagent_type || null, promptProbe: probe.length >= 30 ? probe : null });
      }
    }
    const toolUseToEagerAgent = new Map();
    for (const atc of agentToolCalls) {
      toolUseToEagerAgent.set(atc.toolUseId, atc);
    }

    // --- Attribution precompute ---
    // Resolve every Agent tool call's toolUseId to a real agentId, and use the
    // spawning-prompt probe to attribute unenriched subagent turns to a column.

    // toolUseId -> real agentId. Two sources, both reliable:
    //  1. FIFO pairing of PreToolUse/Agent hooks with the next SubagentStart.
    //  2. An enriched turn whose user text contains a tool call's prompt probe.
    const realAgentForToolUse = new Map();
    {
      const preQueue = [];
      for (const int of interactions) {
        if (!int.isHook) continue;
        if (/PreToolUse/i.test(int.hookEvent) && int.toolName === 'Agent' && int.toolUseId) {
          preQueue.push(int.toolUseId);
        } else if (int.hookEvent === 'SubagentStart' && int.hookAgentId) {
          const tuid = preQueue.shift();
          if (tuid) realAgentForToolUse.set(tuid, int.hookAgentId);
        }
      }
    }
    const probeToolCalls = agentToolCalls.filter(atc => atc.promptProbe);
    function matchTurnToToolUse(interaction) {
      if (probeToolCalls.length === 0) return null;
      const text = turnUserText(interaction);
      if (!text) return null;
      for (const atc of probeToolCalls) {
        if (text.includes(atc.promptProbe)) return atc.toolUseId;
      }
      return null;
    }
    for (const int of interactions) {
      if (int.isHook || int.isMcp) continue;
      const aid = int.subagent?.agentId;
      if (!aid) continue;
      const tuid = matchTurnToToolUse(int);
      if (tuid && !realAgentForToolUse.has(tuid)) realAgentForToolUse.set(tuid, aid);
    }

    // Unenriched standard-LLM turn -> agentId, via its spawning-prompt probe.
    const inferredAgentForTurn = new Map();
    for (const int of interactions) {
      if (int.isHook || int.isMcp || int.subagent?.agentId || !isStandardLlm(int)) continue;
      const tuid = matchTurnToToolUse(int);
      if (!tuid) continue;
      const realAid = realAgentForToolUse.get(tuid);
      const aid = realAid || ('pending-' + tuid);
      inferredAgentForTurn.set(int.id, { agentId: aid, toolUseId: tuid });
    }

    // Extend agentLastIdx using PostToolUse/Agent hooks so columns stay
    // open until the agent actually returns (not just until the last
    // enriched turn, which can be too early with partial enrichment).
    for (const ph of postAgentHooks) {
      if (!ph.toolUseId) continue;
      const eager = toolUseToEagerAgent.get(ph.toolUseId);
      if (!eager) continue;
      const current = agentLastIdx.get(eager.agentId);
      if (current !== undefined && ph.idx > current) {
        agentLastIdx.set(eager.agentId, ph.idx);
      }
    }

    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      let agentId = null;
      if (interaction.isHook) {
        agentId = interaction.subagent?.agentId || interaction.hookAgentId
          || resolveHookAgentId(interaction, interactions.slice(0, idx));
      } else {
        agentId = interaction.subagent?.agentId || null;
        // Fallback for trace-less sessions: the server stamps subagent.agentId
        // authoritatively from Claude's transcripts when available, so this only
        // runs when enrichment is absent. Attributes an unenriched subagent turn
        // via the spawning prompt the parent passed to the Agent tool call —
        // works even with identical concurrent agents; main-thread turns (incl.
        // server-side web searches) match nothing and stay on main.
        if (!agentId) {
          const inferred = inferredAgentForTurn.get(interaction.id);
          if (inferred) {
            // Bind to whichever key the column currently lives under: the real
            // agentId once SubagentStart has reconciled it, otherwise the eager
            // pending key. Avoids allocating a duplicate column.
            const pendingKey = 'pending-' + inferred.toolUseId;
            if (activeColumns.has(inferred.agentId) || historicalColumns.has(inferred.agentId)) {
              agentId = inferred.agentId;
            } else if (activeColumns.has(pendingKey) || historicalColumns.has(pendingKey)) {
              agentId = pendingKey;
            } else {
              agentId = inferred.agentId;
            }
            const col = activeColumns.get(agentId) ?? historicalColumns.get(agentId);
            const agentSub = col != null ? columnAgents.get(col) : null;
            if (agentSub) {
              interaction.subagent = { ...agentSub };
              interaction._subagentInferred = true;
            }
          }
        }
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
          // Key the lane by the real agentId when known (FIFO-resolved from
          // SubagentStart), so the eager column and the announced agent are the
          // same column — no duplicate lane, no reconciliation needed.
          const eagerAid = realAgentForToolUse.get(tc.id) || eager.agentId;
          if (activeColumns.has(eagerAid) || historicalColumns.has(eagerAid)) continue;
          const alloc = allocateColumn(freeColumns, activeColumns, nextColumn);
          nextColumn = alloc.nextColumn;
          activeColumns.set(eagerAid, alloc.col);
          historicalColumns.set(eagerAid, alloc.col);
          const synSub = { agentId: eagerAid, agentType: eager.subagentType || 'agent', description: eager.description };
          if (registerSubagentFn) registerSubagentFn(synSub);
          columnAgents.set(alloc.col, synSub);
          let startHookId = null;
          let startToolUseId = null;
          if (eager.description && pendingPreHooks.length > 0) {
            const mi = pendingPreHooks.findIndex(ph => ph.description === eager.description);
            if (mi >= 0) {
              startHookId = pendingPreHooks[mi].id;
              startToolUseId = pendingPreHooks[mi].toolUseId;
              pendingPreHooks.splice(mi, 1);
            }
          }
          const seg_ = { col: alloc.col, agentId: eagerAid, subagent: synSub, startIdx: idx, endHookId: null, startHookId };
          columnSegments.push(seg_);
          activeSegments.set(eagerAid, seg_);
          if (startToolUseId) startToolUseToSeg.set(startToolUseId, seg_);
        }
      }

      // SubagentStop must never open a new column — only close existing ones
      if (interaction.isHook && interaction.hookEvent === 'SubagentStop'
          && agentId && !activeColumns.has(agentId) && !historicalColumns.has(agentId)) {
        agentId = null;
      }

      // SubagentStart: reconcile with a pending eager column so we don't
      // create a second column before JSONL enrichment links the two IDs.
      if (interaction.isHook && interaction.hookEvent === 'SubagentStart'
          && agentId && !activeColumns.has(agentId) && !historicalColumns.has(agentId)) {
        let pendingKey = null, pendingCount = 0;
        const startToolUseId = interaction.subagent?.toolUseId;
        if (startToolUseId) {
          const exactKey = 'pending-' + startToolUseId;
          if (activeColumns.has(exactKey)) { pendingKey = exactKey; pendingCount = 1; }
        }
        if (!pendingKey) {
          for (const [aid] of activeColumns) {
            if (typeof aid === 'string' && aid.startsWith('pending-')) { pendingKey = aid; pendingCount++; }
          }
        }
        if (pendingCount === 1 && pendingKey) {
          const col = activeColumns.get(pendingKey);
          activeColumns.delete(pendingKey);
          activeColumns.set(agentId, col);
          historicalColumns.delete(pendingKey);
          historicalColumns.set(agentId, col);
          if (interaction.subagent) {
            if (registerSubagentFn) registerSubagentFn(interaction.subagent);
            columnAgents.set(col, interaction.subagent);
          }
          const seg = activeSegments.get(pendingKey);
          if (seg) {
            activeSegments.delete(pendingKey);
            seg.agentId = agentId;
            if (interaction.subagent) seg.subagent = interaction.subagent;
            activeSegments.set(agentId, seg);
          }
          agentLastIdx.delete(pendingKey);
        }
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
        let startToolUseId2 = null;
        const subToolUseId = interaction.subagent?.toolUseId;
        if (subToolUseId && pendingPreHooks.length > 0) {
          const matchIdx = pendingPreHooks.findIndex(ph => ph.toolUseId === subToolUseId);
          if (matchIdx >= 0) {
            startHookId = pendingPreHooks[matchIdx].id;
            startToolUseId2 = pendingPreHooks[matchIdx].toolUseId;
            pendingPreHooks.splice(matchIdx, 1);
          }
        }
        if (!startHookId && pendingPreHooks.length === 1) {
          startHookId = pendingPreHooks[0].id;
          startToolUseId2 = pendingPreHooks[0].toolUseId;
          pendingPreHooks.splice(0, 1);
        }
        const seg = { col, agentId, subagent: interaction.subagent, startIdx: idx, endHookId: null, startHookId };
        columnSegments.push(seg);
        if (startToolUseId2) startToolUseToSeg.set(startToolUseId2, seg);
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

      // Free columns when we pass the agent's last interaction
      if (agentId && activeColumns.has(agentId) && agentLastIdx.get(agentId) === idx) {
        const closedCol = activeColumns.get(agentId);
        const seg = activeSegments.get(agentId);
        if (seg) activeSegments.delete(agentId);
        freeColumns.push(closedCol);
        activeColumns.delete(agentId);
      }

      // Explicit close: PostToolUse/Agent hooks signal the agent returned
      if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent)
          && interaction.toolName === 'Agent' && interaction.toolUseId) {
        let closed = false;
        const eager = toolUseToEagerAgent.get(interaction.toolUseId);
        if (eager && activeColumns.has(eager.agentId)) {
          const closingId = eager.agentId;
          const closedCol = activeColumns.get(closingId);
          const seg = activeSegments.get(closingId);
          if (seg) activeSegments.delete(closingId);
          freeColumns.push(closedCol);
          activeColumns.delete(closingId);
          closed = true;
        }
        if (!closed) {
          const respAgentId = interaction.response?.body?.agentId;
          if (respAgentId && activeColumns.has(respAgentId)) {
            const closedCol = activeColumns.get(respAgentId);
            const seg = activeSegments.get(respAgentId);
            if (seg) activeSegments.delete(respAgentId);
            freeColumns.push(closedCol);
            activeColumns.delete(respAgentId);
          }
        }
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
        if (seg) { seg.startHookId = ph.id; startToolUseToSeg.set(ph.toolUseId, seg); continue; }
      }
      if (ph.description) {
        const seg = columnSegments.find(s => !s.startHookId && s.subagent?.description === ph.description);
        if (seg) { seg.startHookId = ph.id; startToolUseToSeg.set(ph.toolUseId, seg); }
      }
    }

    // Match PostToolUse/Agent hooks to segments for merge arrows.
    // Best signal: toolUseId links the Post hook to the same segment as its Pre hook.
    // Fallback: description matching (fragile with duplicate descriptions).
    for (const ph of postAgentHooks) {
      let matched = false;
      if (ph.toolUseId && startToolUseToSeg.has(ph.toolUseId)) {
        const seg = startToolUseToSeg.get(ph.toolUseId);
        if (seg && !seg.endHookId) {
          seg.endHookId = ph.id;
          postHookClosedCol.set(ph.id, seg.col);
          matched = true;
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

    // Compact columns: remove columns that have no events assigned to them.
    // Column 0 (main thread) is always kept.
    const usedCols = new Set([0]);
    for (const col of columnFor.values()) usedCols.add(col);
    const sortedUsed = [...usedCols].sort((a, b) => a - b);

    if (sortedUsed.length < nextColumn) {
      const colRemap = new Map();
      for (let i = 0; i < sortedUsed.length; i++) colRemap.set(sortedUsed[i], i);

      for (const [id, col] of columnFor) columnFor.set(id, colRemap.get(col) ?? col);

      const remappedAgents = new Map();
      for (const [col, agent] of columnAgents) {
        const nc = colRemap.get(col);
        if (nc !== undefined) remappedAgents.set(nc, agent);
      }
      columnAgents.clear();
      for (const [k, v] of remappedAgents) columnAgents.set(k, v);

      const keptSegs = [];
      for (const seg of columnSegments) {
        const nc = colRemap.get(seg.col);
        if (nc !== undefined) { seg.col = nc; keptSegs.push(seg); }
      }
      columnSegments.length = 0;
      columnSegments.push(...keptSegs);

      const remappedPost = new Map();
      for (const [id, col] of postHookClosedCol) remappedPost.set(id, colRemap.get(col) ?? col);
      postHookClosedCol.clear();
      for (const [k, v] of remappedPost) postHookClosedCol.set(k, v);

      const remappedActive = new Map();
      for (const [aid, col] of activeColumns) {
        const nc = colRemap.get(col);
        if (nc !== undefined) remappedActive.set(aid, nc);
      }
      activeColumns.clear();
      for (const [k, v] of remappedActive) activeColumns.set(k, v);

      const remappedHist = new Map();
      for (const [aid, col] of historicalColumns) {
        const nc = colRemap.get(col);
        if (nc !== undefined) remappedHist.set(aid, nc);
      }
      historicalColumns.clear();
      for (const [k, v] of remappedHist) historicalColumns.set(k, v);

      freeColumns.length = 0;

      nextColumn = sortedUsed.length;
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

  // --- Parallel cohort detection ---
  // A cohort = >=2 lanes (columnSegments) whose first rendered entry starts
  // within COHORT_EPSILON_MS of each other. These were dispatched in parallel
  // (same fork batch) and should share a start rail / merge join bus rather
  // than cascading diagonally.
  function buildCohorts(layout, columnSegments) {
    if (!columnSegments || columnSegments.length === 0) return [];
    const byId = new Map();
    for (const item of layout) {
      if (item.height > 0) byId.set(item.id, item);
    }
    // First and last visible entry per segment.
    const segInfos = [];
    for (const seg of columnSegments) {
      let first = null, last = null;
      for (const item of layout) {
        if (item.height <= 0) continue;
        if (item.col !== seg.col) continue;
        if (item.interaction.subagent?.agentId !== seg.agentId) continue;
        if (first === null || item.idx < first.idx) first = item;
        if (last === null || item.idx > last.idx) last = item;
      }
      if (first) segInfos.push({ seg, first, last, startElapsed: first.elapsed });
    }
    if (segInfos.length < 2) return [];
    segInfos.sort((a, b) => a.startElapsed - b.startElapsed);

    const cohorts = [];
    let group = [segInfos[0]];
    for (let i = 1; i < segInfos.length; i++) {
      if (segInfos[i].startElapsed - group[0].startElapsed <= D3_CONST.COHORT_EPSILON_MS) {
        group.push(segInfos[i]);
      } else {
        if (group.length >= 2) cohorts.push(group);
        group = [segInfos[i]];
      }
    }
    if (group.length >= 2) cohorts.push(group);
    return cohorts;
  }

  // --- Main layout pass ---

  function computeD3Layout(interactions, columnFor, totalColumns, parallelRegions, postHookClosedCol, _depthAt, columnSegments) {
    const C = D3_CONST;
    const layout = [];
    const breaks = [];
    const colBottoms = new Map();
    const sessionStart = interactions.length > 0 ? interactions[0].timestamp : 0;
    let globalBottom = C.HEADER_HEIGHT + 8;
    const availWidth = computeColumnWidth(totalColumns);

    // Start-row model: the y position is driven by START TIME, not by a global
    // running bottom. Elements whose starts fall within COHORT_EPSILON_MS share
    // a "row" and a baseline y, so near-simultaneous (parallel) elements ALIGN —
    // regardless of which column they land in. The time axis is intentionally
    // non-linear: rows step down by a fixed amount, so ordering is top-down and
    // start-correct without being proportional to real elapsed time.
    //
    // Stacking pushes an element DOWN only for two reasons, never because a
    // sibling parallel lane is deep:
    //   1. its own column is still occupied (sequential within a lane), or
    //   2. the main-thread spine (col 0) has advanced past it (causal order).
    const ROW_STEP = C.MIN_ENTRY_HEIGHT + C.MIN_GAP;
    let prevElapsed = null;
    let rowStartElapsed = null;
    let rowBaseline = globalBottom;

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

      // Advance to a new start-row when this element starts more than the
      // epsilon after the current row began. Same-row elements reuse the
      // baseline (and therefore align).
      if (rowStartElapsed === null || (elapsed - rowStartElapsed) > C.COHORT_EPSILON_MS) {
        if (rowStartElapsed !== null) {
          if ((elapsed - prevElapsed) > C.ZIGZAG_MIN_CUT) {
            // Long real-time pause: zigzag break, re-anchor to the deepest content.
            const breakY = globalBottom + C.MIN_GAP + GAP_COLLAPSE_HEIGHT / 2;
            breaks.push({ y: breakY, elapsedBefore: prevElapsed, elapsedAfter: elapsed });
            rowBaseline = breakY + GAP_COLLAPSE_HEIGHT / 2;
          } else {
            rowBaseline += ROW_STEP;
          }
        }
        // Never let a row sit above the main-thread spine's current bottom.
        const mainBottom = colBottoms.get(0);
        if (mainBottom != null) rowBaseline = Math.max(rowBaseline, mainBottom + C.MIN_GAP);
        rowStartElapsed = elapsed;
      }

      let y = rowBaseline;
      const colBottom = colBottoms.get(col);
      if (colBottom != null) y = Math.max(y, colBottom + C.MIN_GAP);

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

    // Cohorts (for merge-bus routing). The start-row model already aligns
    // parallel starts, so no separate snap pass is needed.
    const cohorts = buildCohorts(layout, columnSegments);

    // Monotonic elapsed→Y interpolation for ruler and connectors
    const yPoints = layout.filter(item => item.height > 0)
      .map(item => ({ elapsed: item.elapsed, y: item.y }))
      .sort((a, b) => a.elapsed - b.elapsed);
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

    const cohortAgentGroups = cohorts.map(group => group.map(ci => ci.seg.agentId));
    return { layout, totalHeight: finalBottom + 40, sessionStart, breaks, compressedY: elapsedToY, cohorts: cohortAgentGroups };
  }

  // --- Connector data (fork/merge arrows, bgRects) ---

  function computeConnectorData(layout, columnFor, columnAgents, totalColumns, elapsedToY, sessionStart, postHookClosedCol, columnSegments, opts) {
    const SUBAGENT_COLORS = opts?.subagentColors || ['#6366f1'];
    const getSubagentColor = opts?.getSubagentColor || (() => SUBAGENT_COLORS[0]);
    const connectors = [];
    const colWidth = computeColumnWidth(totalColumns);

    // Parallel-cohort merge routing: members of the same cohort merge through a
    // shared horizontal join bus instead of each drawing its own arrow to main.
    const cohortGroups = opts?.cohorts || [];
    const cohortIdxForAgent = new Map();
    for (let ci = 0; ci < cohortGroups.length; ci++) {
      for (const aid of cohortGroups[ci]) cohortIdxForAgent.set(aid, ci);
    }
    // Per-cohort accumulator: tributaries (one per lane) + the common main target.
    const cohortMerge = new Map();

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

    for (const seg of columnSegments || []) {
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

        // Merge arrow: only when the segment actually ended (has endHookId)
        if (seg.endHookId) {
          let mergeTargetY = null;
          let mergeTargetX = D3_CONST.RULER_WIDTH + colWidth / 2;
          if (hookEntry) {
            mergeTargetY = hookEntry.y + hookEntry.height / 2;
            mergeTargetX = hookEntry.x + hookEntry.width / 2;
          } else if (_foldedHookIds.has(seg.endHookId)) {
            const info = _foldedHookParentInfo.get(seg.endHookId);
            if (info) {
              const parentItem = layoutById.get(info.parentId);
              if (parentItem) {
                const tools = extractToolCalls(parentItem.interaction);
                mergeTargetY = parentItem.y + D3_CONST.MIN_ENTRY_HEIGHT
                  + tools.length * D3_CONST.TOOL_HEIGHT
                  + info.hookIndex * D3_CONST.TOOL_HEIGHT
                  + D3_CONST.TOOL_HEIGHT / 2;
                mergeTargetX = parentItem.x + parentItem.width / 2;
              }
            }
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
            const cohortIdx = cohortIdxForAgent.get(seg.agentId);
            if (cohortIdx != null) {
              // Cohort member: stash this lane's exit point; the join bus and the
              // single shared arrow to main are emitted after the loop.
              if (!cohortMerge.has(cohortIdx)) {
                cohortMerge.set(cohortIdx, { tribs: [], targetY: mergeTargetY, targetX: mergeTargetX });
              }
              const cm = cohortMerge.get(cohortIdx);
              // Use the lowest (latest-finishing) lane's target — a parallel
              // barrier resumes main only after the last lane completes.
              if (mergeTargetY > cm.targetY) { cm.targetY = mergeTargetY; cm.targetX = mergeTargetX; }
              cm.tribs.push({ x: bgCenterX, bottom: bgBottom, color });
            } else {
              const mergeBow = Math.max(20, Math.abs(bgCenterX - mergeTargetX) * 0.2);
              const mergeBotY = Math.max(bgBottom, mergeTargetY) + mergeBow;
              connectors.push({
                type: 'merge', col: seg.col,
                path: `M${bgCenterX},${bgBottom} C${bgCenterX},${mergeBotY} ${mergeTargetX},${mergeBotY} ${mergeTargetX},${mergeTargetY}`,
                color, opacity: 0.6, strokeWidth: 2.5, agentId: seg.agentId,
              });
            }
          }
        }

        connectors.push({
          type: 'bgRect', col: seg.col,
          x: bgLeft, y: bgTop, width: colWidth + 8, height: bgBottom - bgTop,
          color, agentId: seg.agentId,
          isStreaming: entries.some(e => e.interaction.status === 'streaming'),
        });
    }

    // Emit cohort join buses. Each lane's tributary leaves from its OWN box
    // bottom and runs to a shared horizontal bus; a single arrow then drops
    // from the bus into main. Early-finishing lanes show a visible gap down to
    // the bus — the barrier wait made literal.
    for (const cm of cohortMerge.values()) {
      if (cm.tribs.length === 0) continue;
      const busBottom = Math.max(...cm.tribs.map(t => t.bottom));
      const busY = Math.max(busBottom, cm.targetY) - 18;
      const xs = cm.tribs.map(t => t.x);
      const busLeft = Math.min(...xs);
      const busRight = Math.max(...xs);
      const busColor = cm.tribs[0].color;
      // Tributaries: each box bottom curves down to the bus (no arrowhead).
      for (const t of cm.tribs) {
        const midY = (t.bottom + busY) / 2;
        connectors.push({
          type: 'merge-trib', col: 0,
          path: `M${t.x},${t.bottom} C${t.x},${midY} ${t.x},${midY} ${t.x},${busY}`,
          color: t.color, opacity: 0.5, strokeWidth: 2,
        });
      }
      // The horizontal bus line.
      if (busRight - busLeft > 1) {
        connectors.push({
          type: 'merge-trib', col: 0,
          path: `M${busLeft},${busY} L${busRight},${busY}`,
          color: busColor, opacity: 0.5, strokeWidth: 2,
        });
      }
      // Single arrow from the bus down into main.
      const busMidX = (busLeft + busRight) / 2;
      const dropY = (busY + cm.targetY) / 2;
      connectors.push({
        type: 'merge', col: 0,
        path: `M${busMidX},${busY} C${busMidX},${dropY} ${cm.targetX},${dropY} ${cm.targetX},${cm.targetY}`,
        color: busColor, opacity: 0.6, strokeWidth: 2.5,
      });
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
