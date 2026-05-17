(function () {
  'use strict';

  const D3_CONST = {
    RULER_WIDTH: 52,
    COLUMN_WIDTH: 240,
    COLUMN_GAP: 16,
    MIN_ENTRY_HEIGHT: 52,
    TOOL_HEIGHT: 24,
    MIN_GAP: 6,
    TIME_SCALE: 0.04,
    HEADER_HEIGHT: 30,
    ZIGZAG_MIN_CUT: 10000,
  };

  const GAP_COLLAPSE_THRESHOLD = 30000;
  const GAP_COLLAPSE_HEIGHT = 28;

  let _extractToolCalls = null;
  let _isStandardLlm = null;

  let _foldedHookIds = new Set();
  let _foldedHookParentInfo = new Map();

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
    // This determines when each agent's column can be freed — NOT PostToolUse
    // hooks, which fire at launch time (~40ms after PreToolUse), not completion.
    const agentLastIdx = new Map();
    for (let i = 0; i < interactions.length; i++) {
      const aid = interactions[i].subagent?.agentId;
      if (aid) agentLastIdx.set(aid, i);
    }

    // Pre-scan: collect PostToolUse/Agent hooks for segment matching after the main loop.
    // These hooks have agentId=null (they belong to the parent orchestrator),
    // so we match them to segments by description.
    const postAgentHooks = [];
    for (let i = 0; i < interactions.length; i++) {
      const int = interactions[i];
      if (int.isHook && /PostToolUse/i.test(int.hookEvent) && int.toolName === 'Agent') {
        postAgentHooks.push({ id: int.id, idx: i, toolUseId: int.toolUseId, description: int.request?.tool_input?.description });
      }
    }

    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      let agentId = null;
      if (interaction.isHook) {
        agentId = interaction.subagent?.agentId || resolveHookAgentId(interaction, interactions.slice(0, idx));
      } else {
        agentId = interaction.subagent?.agentId || null;
      }

      if (interaction.isHook && interaction.hookEvent && /PreToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
        pendingPreHooks.push({ id: interaction.id, toolUseId: interaction.toolUseId, description: interaction.request?.tool_input?.description });
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
      if (resolvedCol > 0 && interaction.subagent && !columnAgents.has(resolvedCol)) {
        if (registerSubagentFn) registerSubagentFn(interaction.subagent);
        columnAgents.set(resolvedCol, interaction.subagent);
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

    return { columnFor, totalColumns: nextColumn, columnAgents, activeColumns, historicalColumns, freeColumns, nextColumn, parallelRegions, postHookClosedCol, columnSegments, depthAt };
  }

  // --- Node height ---

  function computeNodeHeight(interaction) {
    if (interaction.isHook) return 28;
    if (!isStandardLlm(interaction)) return 28;
    if (interaction.isMcp) return 42;
    const tools = extractToolCalls(interaction);
    const foldedCount = interaction._foldedPreHooks?.length || 0;
    return D3_CONST.MIN_ENTRY_HEIGHT + (tools.length + foldedCount) * D3_CONST.TOOL_HEIGHT;
  }

  // --- Column width ---

  function computeColumnWidth(_totalColumns) {
    return D3_CONST.COLUMN_WIDTH;
  }

  // --- Main layout pass ---

  function computeD3Layout(interactions, columnFor, totalColumns, parallelRegions, postHookClosedCol, depthAt) {
    const C = D3_CONST;
    const layout = [];
    const breaks = [];
    const colBottoms = new Map();
    const sessionStart = interactions.length > 0 ? interactions[0].timestamp : 0;
    let globalBottom = C.HEADER_HEIGHT + 8;
    const availWidth = computeColumnWidth(totalColumns);

    const idxRegion = new Array(interactions.length).fill(null);
    for (const r of (parallelRegions || [])) {
      for (let i = r.startIdx; i <= r.endIdx; i++) idxRegion[i] = r;
    }

    // Per-region: gap compression and minimum viable time scale
    const regionCache = new Map();
    for (const region of (parallelRegions || [])) {
      const regionElapsed = [];
      for (let i = region.startIdx; i <= region.endIdx; i++) {
        regionElapsed.push(interactions[i].timestamp - sessionStart);
      }
      const sorted = [...new Set(regionElapsed)].sort((a, b) => a - b);

      let cumShift = 0;
      const shifts = [];
      const regionBreaks = [];
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1];
        if (gap > GAP_COLLAPSE_THRESHOLD) {
          cumShift += gap - GAP_COLLAPSE_THRESHOLD * 0.1;
          regionBreaks.push({ before: sorted[i - 1], after: sorted[i] });
        }
        shifts.push({ elapsed: sorted[i], shift: cumShift });
      }
      const compressElapsed = (elapsed) => {
        let s = 0;
        for (const { elapsed: e, shift } of shifts) {
          if (e <= elapsed) s = shift; else break;
        }
        return elapsed - s;
      };

      // Scale: from items with 2+ concurrent threads
      const byCols = new Map();
      for (let i = region.startIdx; i <= region.endIdx; i++) {
        if (depthAt && depthAt[i] < 2) continue;
        const col = columnFor.get(interactions[i].id) || 0;
        if (!byCols.has(col)) byCols.set(col, []);
        byCols.get(col).push({
          height: computeNodeHeight(interactions[i]),
          compElapsed: compressElapsed(interactions[i].timestamp - sessionStart)
        });
      }
      let maxScale = 0.005;
      for (const [, nodes] of byCols) {
        for (let i = 0; i < nodes.length - 1; i++) {
          const dt = nodes[i + 1].compElapsed - nodes[i].compElapsed;
          if (dt > 0) {
            const needed = (nodes[i].height + C.MIN_GAP) / dt;
            if (needed > maxScale) maxScale = needed;
          }
        }
      }

      regionCache.set(region, {
        scale: Math.min(maxScale, C.TIME_SCALE),
        compressElapsed,
        regionBreaks,
        startElapsed: region.startTime - sessionStart
      });
    }

    // Main layout pass
    let prevElapsed = null;
    let activeRegion = null;
    let regionStartY = 0;

    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      const elapsed = interaction.timestamp - sessionStart;
      if (_foldedHookIds.has(interaction.id)) {
        layout.push({ id: interaction.id, x: 0, y: 0, width: 0, height: 0, col: 0, interaction, elapsed, idx });
        continue;
      }
      const col = columnFor.get(interaction.id) || 0;
      const height = computeNodeHeight(interaction);
      const x = C.RULER_WIDTH + col * (availWidth + C.COLUMN_GAP);
      const region = idxRegion[idx];
      let y;

      if (region) {
        if (activeRegion !== region) {
          if (prevElapsed != null && (elapsed - prevElapsed) > C.ZIGZAG_MIN_CUT) {
            const breakY = globalBottom + C.MIN_GAP + GAP_COLLAPSE_HEIGHT / 2;
            breaks.push({ y: breakY, elapsedBefore: prevElapsed, elapsedAfter: elapsed });
            globalBottom = breakY + GAP_COLLAPSE_HEIGHT / 2;
          }
          activeRegion = region;
          regionStartY = globalBottom + C.MIN_GAP;
        }

        if (col === 0) {
          const colBottom = colBottoms.get(0) || globalBottom;
          y = colBottom + C.MIN_GAP;
          const closedCol = postHookClosedCol && postHookClosedCol.get(interaction.id);
          if (closedCol != null && colBottoms.has(closedCol)) {
            y = Math.max(y, colBottoms.get(closedCol) + C.MIN_GAP);
          }
        } else if (depthAt && depthAt[idx] >= 2) {
          const rs = regionCache.get(region);
          const compE = rs.compressElapsed(elapsed);
          const compStart = rs.compressElapsed(rs.startElapsed);
          const timeY = regionStartY + (compE - compStart) * rs.scale;

          y = colBottoms.has(col)
            ? Math.max(timeY, colBottoms.get(col) + C.MIN_GAP)
            : timeY;
        } else {
          y = (colBottoms.get(col) || globalBottom) + C.MIN_GAP;
        }
      } else {
        if (activeRegion) activeRegion = null;

        if (prevElapsed != null && (elapsed - prevElapsed) > C.ZIGZAG_MIN_CUT) {
          const breakY = globalBottom + C.MIN_GAP + GAP_COLLAPSE_HEIGHT / 2;
          breaks.push({ y: breakY, elapsedBefore: prevElapsed, elapsedAfter: elapsed });
          globalBottom = breakY + GAP_COLLAPSE_HEIGHT / 2;
        }

        if (col === 0) {
          let maxBottom = globalBottom;
          for (const b of colBottoms.values()) {
            if (b > maxBottom) maxBottom = b;
          }
          y = maxBottom + C.MIN_GAP;
        } else {
          const colBottom = colBottoms.get(col) || globalBottom;
          y = colBottom + C.MIN_GAP;
        }
      }

      // Extend column bottom by actual runtime duration
      let entryBottom = y + height;
      if (region && col > 0 && interaction.timing?.duration > 0) {
        const rs = regionCache.get(region);
        const endElapsed = elapsed + interaction.timing.duration;
        const compEndE = rs.compressElapsed(endElapsed);
        const compStart = rs.compressElapsed(rs.startElapsed);
        const timeEndY = regionStartY + (compEndE - compStart) * rs.scale;
        entryBottom = Math.max(entryBottom, timeEndY);
      }
      layout.push({ id: interaction.id, x, y, width: availWidth, height, col, interaction, elapsed, idx, timeBottom: entryBottom });
      colBottoms.set(col, entryBottom);
      if (entryBottom > globalBottom) globalBottom = entryBottom;
      prevElapsed = elapsed;
    }

    // Monotonic elapsed→Y interpolation
    const yPoints = layout.map(item => ({ elapsed: item.elapsed, y: item.y }));
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

    // Breaks from parallel-region internal gaps
    for (const region of (parallelRegions || [])) {
      const rs = regionCache.get(region);
      for (const br of rs.regionBreaks) {
        if (br.after - br.before <= C.ZIGZAG_MIN_CUT) continue;
        const yBefore = elapsedToY(br.before);
        const yAfter = elapsedToY(br.after);
        breaks.push({ y: (yBefore + yAfter) / 2, elapsedBefore: br.before, elapsedAfter: br.after });
      }
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
    const mainEntries = (colEntries.get(0) || []).filter(item => !_foldedHookIds.has(item.id));

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

        const cpX = (bgLeft - forkOriginX) * 0.6;
        connectors.push({
          type: 'fork', col: seg.col,
          path: `M${forkOriginX},${forkOriginY} C${forkOriginX + cpX},${forkOriginY} ${bgLeft - cpX},${bgTop} ${bgLeft},${bgTop}`,
          color, opacity: 0.6, strokeWidth: 1.5, agentId: seg.agentId,
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
          const mCpX = (bgCenterX - mergeTargetX) * 0.6;
          connectors.push({
            type: 'merge', col: seg.col,
            path: `M${bgCenterX},${bgBottom} C${bgCenterX - mCpX},${bgBottom} ${mergeTargetX + mCpX},${mergeTargetY} ${mergeTargetX},${mergeTargetY}`,
            color, opacity: 0.5, strokeWidth: 1.5, agentId: seg.agentId,
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
        const cpX = (bgLeft - forkOriginX) * 0.6;
        connectors.push({
          type: 'fork', col,
          path: `M${forkOriginX},${forkOriginY} C${forkOriginX + cpX},${forkOriginY} ${bgLeft - cpX},${bgTop} ${bgLeft},${bgTop}`,
          color, opacity: 0.6, strokeWidth: 1.5, agentId: agent?.agentId,
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

  window.wideLayout = {
    init,
    D3_CONST,
    resolveHookAgentId,
    resolveClosedAgentId,
    allocateColumn,
    buildFoldedHooksMap,
    buildColumnAssignment,
    computeNodeHeight,
    computeColumnWidth,
    computeD3Layout,
    computeConnectorData,
    isFoldedHook,
    getFoldedHookParentInfo,
  };
})();
