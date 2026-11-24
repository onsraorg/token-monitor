(() => {
  const params = new URLSearchParams(window.location.search);
  const currentConvId = () => window.sidecar?.conversationId || params.get('conversationId') || '';
  function post(url, data) {
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
    return window.sidecar?.fetch ? window.sidecar.fetch(url, options) : fetch(url, options);
  }

  const PAGE_SIZE = 50;
  const LOW_CACHE_THRESHOLD = 0.85;
  const OVERVIEW_LOW_CACHE_THRESHOLD = 0.80;
  const BIG_DELTA_THRESHOLD = 10_000;

  let activeTab = 'conv';
  let overviewSort = 'recent';
  let changesOnly = false;
  let switchesOnly = false;
  let lastEtag = '';
  let overviewEtag = '';
  let overviewRequest = 0;
  let lastPayload = null;
  let lastOverview = null;
  let visibleTurns = PAGE_SIZE;
  let expandedTurn = null;
  let currentModelMeta = { isMultiModel: false, isOrchestrated: false, byModel: new Map(), ordered: [] };
  const pendingTabs = new Set();
  let pollTimer = null;
  let menuTarget = null;
  let pendingContextMenu = null;
  let pendingDelete = null;
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);

  // Sync light/dark color-scheme with host CSS variables pushed by preload.js
  function syncThemeFromHost() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    if (!bg) return;
    const m = bg.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return;
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = luma < 128 ? 'dark' : 'light';
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'theme-change') {
      requestAnimationFrame(syncThemeFromHost);
    }
  });
  syncThemeFromHost();

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
    return String(v);
  }

  function fmtLimit(n) {
    if (n >= 1_000_000) return `${n / 1_000_000}M`;
    return `${Math.round(n / 1_000)}K`;
  }

  function fmtPct(ratio) {
    const pct = Math.max(0, (Number(ratio) || 0) * 100);
    if (pct === 0) return '0%';
    if (pct < 10) return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
  }

  function fmtUsd(usd, { precise = false } = {}) {
    if (usd === null || usd === undefined) return '—';
    const v = Number(usd);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v === 0) return '$0.00';
    if (v < 0.01) return precise ? `$${v.toFixed(4)}` : '<$0.01';
    if (v < 100) return `$${v.toFixed(2)}`;
    return `$${v.toFixed(1)}`;
  }

  function formatCostTooltip(cost) {
    if (!cost || !cost.pricedTurns) return 'No applicable rate or pricing date';
    const parts = [
      `Input ${fmtUsd(cost.inputUsd, { precise: true })}`,
      `Cache ${fmtUsd(cost.cacheReadUsd, { precise: true })}`,
      `Output ${fmtUsd(cost.outputUsd, { precise: true })}`,
    ];
    if (cost.cacheSavedUsd >= 0.01) parts.push(`Cache savings ${fmtUsd(cost.cacheSavedUsd)}`);
    if (cost.unpricedTurns > 0) parts.push(`Unpriced turns: ${cost.unpricedTurns}`);
    return parts.join(' · ');
  }

  function fmtDuration(sec) {
    if (sec === null || sec === undefined) return '—';
    const v = Number(sec);
    if (!Number.isFinite(v) || v <= 0) return '—';
    if (v >= 60) {
      const seconds = Math.round(v);
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }
    return `${Number(v.toFixed(v >= 10 ? 1 : 2))} s`;
  }

  function estimatedTps(turn) {
    if (!(turn?.logGapSec > 0 && turn.outputTokens > 0)) return '—';
    const rate = turn.outputTokens / turn.logGapSec;
    const digits = rate >= 100 ? 0 : rate >= 1 ? 1 : 2;
    return `${Number(rate.toFixed(digits))} t/s`;
  }

  function timingTone(sec) {
    if (sec == null) return 'muted-tone';
    const v = Number(sec);
    if (!Number.isFinite(v) || v <= 0) return 'muted-tone';
    if (v >= 90) return 'dur-6';
    if (v >= 48) return 'dur-5';
    if (v >= 28) return 'dur-4';
    if (v >= 16) return 'dur-3';
    if (v >= 10) return 'dur-2';
    return 'dur-1';
  }

  function fmtTime(iso) {
    if (!iso) return '--:--:--';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toLocaleTimeString('en-GB', { hour12: false });
  }

  function setLive(ok, label) {
    const dot = $('live-dot');
    dot.classList.toggle('stale', !ok);
    dot.title = label;
    dot.setAttribute('aria-label', label);
  }

  function buildModelMeta(orchestration) {
    const models = orchestration?.models || [];
    const isMultiModel = Boolean(orchestration?.isMultiModel && models.length >= 2);
    const isOrchestrated = Boolean(orchestration?.isOrchestrated && isMultiModel);
    const ordered = [...models];
    if (isOrchestrated) {
      const rank = (m) => (m.role === 'planner' ? 0 : m.role === 'executor' ? 1 : 2);
      ordered.sort((a, b) => rank(a) - rank(b) || b.totalTokens - a.totalTokens);
    }
    const byModel = new Map();
    ordered.forEach((m, idx) => {
      byModel.set(m.model, { ...m, colorClass: `model-c${idx % 4}` });
    });
    return { isMultiModel, isOrchestrated, byModel, ordered };
  }

  function fmtUsdShort(usd) {
    if (usd === null || usd === undefined) return '—';
    const v = Number(usd);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v === 0) return '$0';
    if (v < 0.01) return '<$0.01';
    if (v < 10) return `$${v.toFixed(2)}`;
    if (v < 100) return `$${v.toFixed(1)}`;
    return `$${Math.round(v)}`;
  }

  function renderSummaryLines(container, rows) {
    const frag = document.createDocumentFragment();
    for (const { label, value, title } of rows) {
      const row = document.createElement('span');
      row.className = 'summary-kv';
      if (title) row.title = title;
      const k = document.createElement('span');
      k.className = 'summary-k';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'summary-v';
      v.textContent = value;
      row.append(k, v);
      frag.appendChild(row);
    }
    container.replaceChildren(frag);
  }

  function renderCost(cost) {
    const wrap = $('cost-wrap');
    const totalEl = $('cost-total');
    const savedEl = $('cost-saved');
    const breakdownEl = $('cost-breakdown');

    if (!cost || !cost.pricedTurns) {
      totalEl.textContent = '—';
      savedEl.hidden = true;
      breakdownEl.textContent = 'No priced turns';
      wrap.title = formatCostTooltip(cost);
      return;
    }

    const tip = formatCostTooltip(cost);
    wrap.title = tip;
    totalEl.textContent = `≈ ${fmtUsd(cost.totalUsd)}`;

    const showSaved = cost.cacheSavedUsd >= 0.01;
    savedEl.hidden = !showSaved;
    if (showSaved) {
      const noCacheTotal = cost.totalUsd + cost.cacheSavedUsd;
      savedEl.textContent = `Saved ${fmtUsdShort(cost.cacheSavedUsd)}`;
      savedEl.title = `Estimated savings versus uncached input: ${fmtUsd(cost.cacheSavedUsd)} · Uncached estimate: ${fmtUsd(noCacheTotal)}`;
      wrap.title = `${tip} · Uncached estimate: ${fmtUsd(noCacheTotal)}`;
    }

    renderSummaryLines(breakdownEl, [
      { label: 'Input', value: fmtUsd(cost.inputUsd), title: `New input estimate: ${fmtUsd(cost.inputUsd, { precise: true })}` },
      { label: 'Cache', value: fmtUsd(cost.cacheReadUsd), title: `Cache read estimate: ${fmtUsd(cost.cacheReadUsd, { precise: true })}` },
      { label: 'Output', value: fmtUsd(cost.outputUsd), title: `Output estimate: ${fmtUsd(cost.outputUsd, { precise: true })}` },
    ]);
  }

  function renderTurnDetail(turn, delta) {
    const detail = document.createElement('div');
    detail.className = 'row-detail';
    const card = document.createElement('div');
    card.className = 'row-detail-card';

    const isSlowReply = turn.logGapSec >= 10 && turn.outputTokens < 100;
    const isLongOutput = turn.outputTokens >= 5000;
    const items = [
      { label: 'Est. time', value: fmtDuration(turn.logGapSec), tone: timingTone(turn.logGapSec) },
      { label: 'Est. TPS', value: estimatedTps(turn) },
      { label: 'Context delta', value: delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toLocaleString()}` },
      { label: 'Cache reads', value: turn.cacheReadTokens.toLocaleString() },
      { label: 'New input', value: turn.inputTokens.toLocaleString() },
      { label: 'Output', value: turn.outputTokens.toLocaleString() },
    ];
    if (isSlowReply) items.push({ label: 'Timing note', value: 'Long interval, short reply', tone: 'warn-tone', wide: true });
    else if (isLongOutput) items.push({ label: 'Timing note', value: 'Long output', wide: true });
    if (turn.costUsd != null) {
      items.push({ label: 'API estimate', value: fmtUsd(turn.costUsd, { precise: true }), tone: 'ok-tone' });
    }
    if (Array.isArray(turn.tools) && turn.tools.length > 0) {
      items.push({ label: 'Tools', value: turn.tools.join(' · '), wide: true });
    }
    if (turn.model) {
      items.push({ label: 'Model', value: turn.model, wide: true });
    }

    for (const item of items) {
      const kv = document.createElement('div');
      kv.className = `detail-kv${item.wide ? ' detail-wide' : ''}`;
      const k = document.createElement('span');
      k.className = 'detail-k';
      k.textContent = item.label;
      const v = document.createElement('span');
      v.className = `detail-v${item.tone ? ` ${item.tone}` : ''}`;
      v.textContent = item.value;
      v.title = item.value;
      kv.append(k, v);
      card.append(kv);
    }

    detail.append(card);
    return detail;
  }

  function renderStream(turns, append = false) {
    const list = $('stream-list');
    const filterBtn = $('changes-only');
    const threshold = changesOnly ? Number(filterBtn.dataset.threshold || BIG_DELTA_THRESHOLD) : 0;
    const filterSwitches = switchesOnly && currentModelMeta.isMultiModel;
    const isFiltered = Boolean(threshold || filterSwitches);
    const offset = append ? list.childElementCount : 0;
    const focusedTurn = list.contains(document.activeElement) ? document.activeElement.dataset.turnIndex : null;
    const frag = document.createDocumentFragment();
    let nextFocus;
    let shown = 0;
    let matched = 0;
    let hasMore = false;

    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      const delta = i ? turn.contextTokens - turns[i - 1].contextTokens : null;
      if (threshold && (delta == null || Math.abs(delta) < threshold)) continue;
      if (filterSwitches && !turn.modelSwitch && !turn.planAction) continue;
      matched += 1;
      if (shown === visibleTurns) {
        hasMore = true;
        continue;
      }
      if (shown++ < offset) continue;

      const wrap = document.createElement('div');
      wrap.className = 'stream-row-wrap';
      wrap.setAttribute('role', 'listitem');

      const mInfo = currentModelMeta.isMultiModel ? currentModelMeta.byModel.get(turn.model) : null;
      if (currentModelMeta.isMultiModel && turn.modelSwitch && mInfo) {
        const banner = document.createElement('div');
        banner.className = 'handoff-banner';
        const left = document.createElement('span');
        left.className = 'handoff-left';
        const dot = document.createElement('span');
        dot.className = `model-dot ${mInfo.colorClass}`;
        const label = mInfo.roleLabel
          ? `⇄ Switch to ${mInfo.roleLabel} · ${mInfo.modelLabel}`
          : `⇄ Switch to ${mInfo.modelLabel}`;
        left.append(dot, label);
        left.title = label;
        banner.append(left);
        if (turn.cacheRate < 0.1 && turn.inputTokens >= BIG_DELTA_THRESHOLD) {
          const tag = document.createElement('span');
          tag.className = 'handoff-tag';
          tag.textContent = 'Cache rebuild';
          tag.title = `Low cache hit after the switch. New input: ${turn.inputTokens.toLocaleString()}`;
          banner.append(tag);
        }
        wrap.append(banner);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stream-row-btn';
      btn.dataset.turnIndex = turn.turnIndex;
      if (focusedTurn === btn.dataset.turnIndex) nextFocus = btn;
      const isExpanded = expandedTurn === turn.turnIndex;
      btn.setAttribute('aria-expanded', String(isExpanded));
      btn.addEventListener('click', () => {
        const open = list.querySelector('[aria-expanded="true"]');
        if (open) {
          open.setAttribute('aria-expanded', 'false');
          open.nextElementSibling?.remove();
        }
        expandedTurn = open === btn ? null : turn.turnIndex;
        if (expandedTurn !== null) {
          btn.setAttribute('aria-expanded', 'true');
          wrap.append(renderTurnDetail(turn, delta));
        }
      });

      // Col 1: Turn index + model dot + role pill + timestamp
      const timeCell = document.createElement('span');
      timeCell.className = 'cell';
      const headRow = document.createElement('span');
      headRow.className = 'row-primary';
      if (mInfo) {
        const mDot = document.createElement('span');
        mDot.className = `model-dot ${mInfo.colorClass}`;
        mDot.title = mInfo.roleLabel ? `${mInfo.roleLabel} · ${mInfo.modelLabel}` : mInfo.modelLabel;
        headRow.append(mDot);
      }
      const idxEl = document.createElement('span');
      idxEl.textContent = `#${turn.turnIndex}`;
      const roleEl = document.createElement('span');
      if (turn.planAction === 'exit') {
        roleEl.className = 'role-pill role-plan-action';
        roleEl.textContent = 'Exit plan';
        roleEl.title = 'Exited planning (exit_plan_mode)';
      } else if (turn.planAction === 'enter') {
        roleEl.className = 'role-pill role-plan-action';
        roleEl.textContent = 'Enter plan';
        roleEl.title = 'Entered planning (enter_plan_mode)';
      } else {
        const isTool = turn.kind === 'Tool call';
        roleEl.className = `role-pill ${isTool ? 'role-tool' : 'role-reply'}`;
        roleEl.textContent = turn.kind;
      }
      headRow.append(idxEl, roleEl);
      const timeSub = document.createElement('span');
      timeSub.className = 'row-secondary';
      timeSub.textContent = mInfo?.roleLabel
        ? `${fmtTime(turn.createdAt)} · ${mInfo.roleLabel}`
        : fmtTime(turn.createdAt);
      timeCell.append(headRow, timeSub);

      // Col 2: Duration (gradient color) + TPS
      const timing = document.createElement('span');
      timing.className = 'cell cell-right';
      const duration = document.createElement('span');
      duration.className = `row-primary ${timingTone(turn.logGapSec)}`;
      duration.textContent = fmtDuration(turn.logGapSec);
      const rate = document.createElement('span');
      rate.className = 'row-secondary';
      rate.textContent = estimatedTps(turn);
      timing.append(duration, rate);

      // Col 3: Context + delta/cache badge + I/O breakdown
      const contextCell = document.createElement('span');
      contextCell.className = 'cell cell-right';
      const context = document.createElement('span');
      context.className = 'row-primary';
      const ctxVal = document.createElement('span');
      ctxVal.textContent = fmtTokens(turn.contextTokens);
      context.append(ctxVal);

      const isBigDelta = delta != null && Math.abs(delta) >= BIG_DELTA_THRESHOLD;
      const isLowCache = turn.contextTokens > 0 && turn.cacheRate < LOW_CACHE_THRESHOLD;
      if (isBigDelta) {
        const deltaBadge = document.createElement('span');
        deltaBadge.className = `delta-badge${delta < 0 ? ' neg' : ''}`;
        deltaBadge.textContent = `${delta > 0 ? '+' : '-'}${fmtTokens(Math.abs(delta))}`;
        deltaBadge.title = `Context change from the prior turn: ${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;
        context.append(deltaBadge);
      } else {
        const cache = document.createElement('span');
        cache.className = `row-cache${isLowCache ? ' low' : ''}`;
        cache.textContent = fmtPct(turn.cacheRate);
        cache.title = `Cache hit rate ${fmtPct(turn.cacheRate)}`;
        context.append(cache);
      }

      const usage = document.createElement('span');
      usage.className = 'row-secondary';
      if (isBigDelta && isLowCache) {
        const cacheNote = document.createElement('span');
        cacheNote.className = 'warn-tone';
        cacheNote.textContent = `Cache ${fmtPct(turn.cacheRate)}`;
        usage.append(cacheNote, ` · ↓${fmtTokens(turn.outputTokens)}`);
        usage.title = `New input ${turn.inputTokens.toLocaleString()} · Output ${turn.outputTokens.toLocaleString()}`;
      } else {
        usage.textContent = `↑${fmtTokens(turn.inputTokens)} ↓${fmtTokens(turn.outputTokens)}`;
        usage.title = 'New input / Output';
      }
      contextCell.append(context, usage);

      btn.append(timeCell, timing, contextCell);
      wrap.append(btn);
      if (isExpanded) wrap.append(renderTurnDetail(turn, delta));
      frag.append(wrap);
    }

    if (append) {
      const firstNewRow = frag.firstElementChild;
      list.append(frag);
      firstNewRow?.firstElementChild?.focus();
    } else {
      list.replaceChildren(frag);
      if (focusedTurn) (nextFocus || filterBtn).focus({ preventScroll: true });
    }

    $('stream-count').textContent = isFiltered
      ? `${matched} / ${turns.length}`
      : `${turns.length} turns`;

    const empty = $('stream-empty');
    empty.hidden = shown > 0;
    if (!shown) empty.textContent = isFiltered ? 'No turns match these filters.' : 'No main-agent turns recorded.';
    $('load-more').hidden = !hasMore;
  }

  function renderOrchestration(orchestration, mainTokens, isNewConv) {
    const badge = $('orch-badge');
    const details = $('model-details');
    const switchBtn = $('switches-only');
    const isMulti = currentModelMeta.isMultiModel;

    badge.hidden = !isMulti;
    details.hidden = !isMulti;
    switchBtn.hidden = !isMulti;

    if (!isMulti) {
      if (switchesOnly) {
        switchesOnly = false;
        switchBtn.setAttribute('aria-checked', 'false');
      }
      return;
    }

    const switches = orchestration.switchCount || 0;
    badge.textContent = currentModelMeta.isOrchestrated
      ? (switches > 0 ? `${switches} switches` : `${orchestration.modelCount} models`)
      : `${orchestration.modelCount} models · ${switches} switches`;
    badge.title = currentModelMeta.ordered
      .map((m) => `${m.roleLabel ? `[${m.roleLabel}] ` : ''}${m.modelLabel} (${m.turns} turns)`)
      .join('\n');

    if (isNewConv) {
      details.open = true;
    }

    $('model-details-title').textContent = currentModelMeta.isOrchestrated ? 'Orchestration' : 'Models';
    $('model-count').textContent = `${orchestration.modelCount}`;
    $('model-switches').textContent = switches > 0 ? `${switches} switches` : `${orchestration.modelCount} models`;

    const totalBase = mainTokens > 0
      ? mainTokens
      : currentModelMeta.ordered.reduce((sum, m) => sum + (m.totalTokens || 0), 0);

    const frag = document.createDocumentFragment();
    for (const m of currentModelMeta.ordered) {
      const info = currentModelMeta.byModel.get(m.model);
      const row = document.createElement('div');
      row.className = 'subagent-row';
      row.setAttribute('role', 'listitem');

      const left = document.createElement('div');
      left.className = 'subagent-left';
      const nameGroup = document.createElement('div');
      nameGroup.className = 'model-name-group';
      const dot = document.createElement('span');
      dot.className = `model-dot ${info.colorClass}`;
      const name = document.createElement('span');
      name.className = 'subagent-name';
      name.textContent = m.modelLabel;
      name.title = m.model;
      nameGroup.append(dot, name);
      if (m.roleLabel) {
        const pill = document.createElement('span');
        pill.className = `role-pill ${m.role === 'planner' ? 'role-planner' : 'role-executor'}`;
        pill.textContent = m.roleLabel;
        nameGroup.append(pill);
      }
      const meta = document.createElement('span');
      meta.className = 'subagent-meta';
      meta.textContent = `${m.turns} turns · Cache ${fmtPct(m.cacheRate)} · ↑${fmtTokens(m.inputTokens)}`;
      left.append(nameGroup, meta);

      const right = document.createElement('div');
      right.className = 'subagent-right';
      const tokens = document.createElement('span');
      tokens.className = 'subagent-tokens';
      tokens.textContent = fmtTokens(m.totalTokens);
      tokens.title = `Total tokens ${m.totalTokens.toLocaleString()} · Output ${m.outputTokens.toLocaleString()}`;
      const sharePct = totalBase > 0 ? Math.round((m.totalTokens / totalBase) * 100) : 0;
      const subRight = document.createElement('span');
      subRight.className = 'subagent-meta';
      if (m.costUsd != null) {
        const costSpan = document.createElement('span');
        costSpan.className = 'cost-inline';
        costSpan.textContent = fmtUsd(m.costUsd);
        if (m.cacheSavedUsd >= 0.01) {
          costSpan.title = `API estimate: ${fmtUsd(m.costUsd)} · Cache savings ${fmtUsd(m.cacheSavedUsd)}`;
        }
        subRight.append(costSpan, ` · ${sharePct}%`);
      } else {
        subRight.textContent = `${sharePct}%`;
      }
      right.append(tokens, subRight);

      row.append(left, right);
      frag.appendChild(row);
    }

    $('model-list').replaceChildren(frag);
  }

  function renderSubagents(agents, subagentTotalTokens) {
    const details = $('subagent-details');
    details.hidden = !agents.length;
    if (!agents.length) return;

    $('subagent-count').textContent = String(agents.length);
    const pricedSubagents = agents.filter((a) => a.costUsd != null);
    const subagentTotalCost = pricedSubagents.reduce((sum, a) => sum + a.costUsd, 0);
    const totalEl = $('subagent-total');
    if (pricedSubagents.length > 0) {
      const costSpan = document.createElement('span');
      costSpan.className = 'cost-inline';
      costSpan.textContent = fmtUsd(subagentTotalCost);
      totalEl.replaceChildren(fmtTokens(subagentTotalTokens), ' · ', costSpan);
    } else {
      totalEl.textContent = fmtTokens(subagentTotalTokens);
    }

    const nameCounts = new Map();
    for (const a of agents) nameCounts.set(a.name, (nameCounts.get(a.name) || 0) + 1);
    const nameSeen = new Map();
    const frag = document.createDocumentFragment();
    for (const agent of agents) {
      const row = document.createElement('div');
      row.className = 'subagent-row';
      row.setAttribute('role', 'listitem');

      const left = document.createElement('div');
      left.className = 'subagent-left';
      const name = document.createElement('span');
      name.className = 'subagent-name';
      const seen = (nameSeen.get(agent.name) || 0) + 1;
      nameSeen.set(agent.name, seen);
      name.textContent = (nameCounts.get(agent.name) || 0) > 1 ? `${agent.name} #${seen}` : agent.name;
      name.title = agent.conversationId;
      const meta = document.createElement('span');
      meta.className = 'subagent-meta';
      const modelPart = agent.modelLabel || 'Unknown model';
      const turnsPart = agent.turns == null ? 'Pending' : `${agent.turns} turns`;
      meta.textContent = `${modelPart} · ${turnsPart}`;
      left.append(name, meta);

      const right = document.createElement('div');
      right.className = 'subagent-right';
      const tokens = document.createElement('span');
      tokens.className = 'subagent-tokens';
      tokens.textContent = agent.totalTokens == null ? 'No data' : fmtTokens(agent.totalTokens);
      if (agent.totalTokens != null) tokens.title = agent.totalTokens.toLocaleString();
      const sharePct = subagentTotalTokens > 0 && agent.totalTokens != null
        ? Math.round((agent.totalTokens / subagentTotalTokens) * 100)
        : null;
      const subRight = document.createElement('span');
      subRight.className = 'subagent-meta';
      if (agent.costUsd != null) {
        const costSpan = document.createElement('span');
        costSpan.className = 'cost-inline';
        costSpan.textContent = fmtUsd(agent.costUsd);
        costSpan.title = `Subagent API estimate: ${fmtUsd(agent.costUsd, { precise: true })}`;
        subRight.append(costSpan);
        if (sharePct != null) subRight.append(` · ${sharePct}%`);
      } else {
        subRight.textContent = sharePct == null ? '—' : `${sharePct}%`;
      }
      right.append(tokens, subRight);

      row.append(left, right);
      frag.appendChild(row);
    }

    $('subagent-list').replaceChildren(frag);
  }

  function renderContext(data) {
    const select = $('ctx-limit-select');
    const selection = select.value;
    const isAutomatic = selection === 'auto';
    const limit = isAutomatic ? (data.modelLimit || 1_000_000) : Number(selection);
    const autoOpt = select.querySelector('option[value="auto"]');
    if (autoOpt) autoOpt.textContent = `Auto ≈${fmtLimit(data.modelLimit || 1_000_000)}`;

    const latest = data.latest;
    const used = latest?.contextTokens;
    const ratio = used == null ? null : used / limit;
    const remaining = used == null ? null : limit - used;

    const isWarn = ratio != null && ratio >= 0.6 && ratio < 0.85;
    const isDanger = ratio != null && ratio >= 0.85;
    const isOk = ratio != null && ratio < 0.6;

    const contextPercent = $('hero-ctx-pct');
    contextPercent.textContent = ratio == null ? '—' : fmtPct(ratio);
    contextPercent.classList.toggle('ok-tone', isOk);
    contextPercent.classList.toggle('warn-tone', isWarn);
    contextPercent.classList.toggle('danger-tone', isDanger);

    $('hero-ctx-frac').textContent = `${used == null ? '—' : fmtTokens(used)} / ${isAutomatic ? '≈' : ''}${fmtLimit(limit)}`;
    const headroom = $('hero-ctx-remaining');
    headroom.hidden = remaining == null;
    if (remaining != null) {
      headroom.textContent = `${remaining < 0 ? 'Over by' : 'Left'}${isAutomatic ? ' ≈' : ''} ${fmtTokens(Math.abs(remaining))}`;
    }

    const cacheInline = $('hero-cache-inline');
    if (latest) {
      const latestCache = latest.cacheRate;
      const cacheSpan = document.createElement('span');
      cacheSpan.className = `cache-inline-val ${latestCache < LOW_CACHE_THRESHOLD ? 'warn-tone' : 'cache-tone'}`;
      cacheSpan.textContent = fmtPct(latestCache);
      const avgText = data.totals ? ` · Avg ${fmtPct(data.totals.overallCacheRate)}` : '';
      cacheInline.replaceChildren('Cache ', cacheSpan, avgText);
      cacheInline.title = `Cache reads this turn: ${latest.cacheReadTokens.toLocaleString()} · New input ${latest.inputTokens.toLocaleString()}`;
    } else {
      cacheInline.textContent = '';
    }

    const barBlock = $('ctx-bar-block');
    const bar = $('ctx-progress');
    barBlock.hidden = ratio == null;
    if (ratio != null) {
      const pctNum = Math.min(100, Math.round(ratio * 100));
      bar.setAttribute('aria-valuenow', String(pctNum));
      bar.classList.toggle('warn', isWarn);
      bar.classList.toggle('danger', isDanger);

      const cacheTokens = Math.max(0, Number(latest.cacheReadTokens) || 0);
      const inputTokens = Math.max(0, Number(latest.inputTokens) || 0);
      const cacheW = Math.min(100, (cacheTokens / limit) * 100);
      const rawNewW = (inputTokens / limit) * 100;
      const newW = inputTokens > 0 ? Math.min(100 - cacheW, Math.max(0.8, rawNewW)) : 0;

      $('ctx-bar-cache').style.inlineSize = `${cacheW.toFixed(2)}%`;
      $('ctx-bar-new').style.inlineSize = `${newW.toFixed(2)}%`;
      bar.title = `Cache reads ${cacheTokens.toLocaleString()} + New input ${inputTokens.toLocaleString()}`;
    }

    renderCost(data.cost);
  }

  function renderConversation(data) {
    const isNewConv = lastPayload?.conversationId !== data.conversationId;
    if (isNewConv) {
      visibleTurns = PAGE_SIZE;
      expandedTurn = null;
      switchesOnly = false;
      $('switches-only').setAttribute('aria-checked', 'false');
    }
    lastPayload = data;
    const convId = currentConvId();

    if (!convId) {
      $('conv-empty').hidden = false;
      $('conv-body').hidden = true;
      $('orch-badge').hidden = true;
      $('model-name').textContent = 'Token Monitor';
      $('empty-title').textContent = 'No conversation selected';
      $('empty-desc').textContent = 'Open the pane from an Antigravity conversation or choose Overview to see local history.';
      return;
    }

    if (!data?.found) {
      $('conv-empty').hidden = false;
      $('conv-body').hidden = true;
      $('orch-badge').hidden = true;
      $('model-name').textContent = 'Token Monitor';
      $('empty-title').textContent = 'No token records for this conversation';
      $('empty-desc').textContent = 'Usage, cache hits, and context size appear after the first model response.';
      return;
    }

    $('conv-empty').hidden = true;
    $('conv-body').hidden = false;

    const modelEl = $('model-name');
    modelEl.textContent = data.modelLabel || data.model || 'Token Monitor';
    modelEl.title = data.model || '';

    currentModelMeta = buildModelMeta(data.orchestration);
    renderOrchestration(data.orchestration || {}, data.mainTokens || 0, isNewConv);

    const totals = data.totals;
    $('hero-total').textContent = fmtTokens(totals.totalTokens);
    $('hero-turns').textContent = `${totals.turns} turns`;

    const agents = data.subagents || [];
    const subagentTokens = Math.max(0, totals.totalTokens - (data.mainTokens || 0));
    const hasSubagents = agents.length > 0;
    renderSummaryLines($('hero-vol-sub'), [
      { label: 'Input', value: fmtTokens(totals.inputTokens), title: `Total new input: ${totals.inputTokens.toLocaleString()}` },
      { label: 'Cache', value: fmtTokens(totals.cacheReadTokens), title: `Total cache reads: ${totals.cacheReadTokens.toLocaleString()}` },
      { label: 'Output', value: fmtTokens(totals.outputTokens), title: `Total output: ${totals.outputTokens.toLocaleString()}` },
    ]);
    $('vol-wrap').title = `Total new input: ${totals.inputTokens.toLocaleString()} · Cache reads ${totals.cacheReadTokens.toLocaleString()} · Output ${totals.outputTokens.toLocaleString()}${hasSubagents ? ` · Subagents ${subagentTokens.toLocaleString()}` : ''}`;

    renderSubagents(agents, subagentTokens);
    renderContext(data);
    renderStream(data.turns || []);
  }

  function renderOverview(data) {
    lastOverview = data;
    const unavailable = data.unavailableStores;
    const warning = $('overview-warning');
    warning.hidden = !unavailable.length;
    warning.textContent = unavailable.length ? `Some local stores could not be read: ${unavailable.join(', ')}` : '';
    $('today-date').textContent = data.todayDate || '';
    $('ov-today-total').textContent = fmtTokens(data.today.totalTokens);
    $('ov-today-meta').textContent = `${data.today.conversations} chats · ${data.today.turns} turns`;

    const todayTotal = data.today.totalTokens || 0;
    const todayCostEl = $('ov-today-cost');
    const hasTodayCost = Boolean(data.todayCost?.pricedTurns > 0);
    todayCostEl.hidden = !hasTodayCost;
    if (hasTodayCost) {
      todayCostEl.textContent = `≈ ${fmtUsd(data.todayCost.totalUsd)}`;
      todayCostEl.title = formatCostTooltip(data.todayCost);
    }

    const cachePct = todayTotal > 0 ? (data.today.cacheReadTokens / todayTotal) * 100 : 0;
    const inPct = todayTotal > 0 ? (data.today.inputTokens / todayTotal) * 100 : 0;
    const outPct = todayTotal > 0 ? (data.today.outputTokens / todayTotal) * 100 : 0;
    $('ov-mix-cache').style.inlineSize = `${cachePct.toFixed(1)}%`;
    $('ov-mix-in').style.inlineSize = `${inPct.toFixed(1)}%`;
    $('ov-mix-out').style.inlineSize = `${outPct.toFixed(1)}%`;

    const todayRateEl = $('ov-today-rate');
    todayRateEl.textContent = fmtPct(data.today.overallCacheRate);
    const isTodayLowCache = todayTotal > 0 && data.today.overallCacheRate < OVERVIEW_LOW_CACHE_THRESHOLD;
    todayRateEl.classList.toggle('warn-tone', isTodayLowCache);
    todayRateEl.classList.toggle('cache-tone', todayTotal > 0 && !isTodayLowCache);
    $('ov-today-cache').textContent = `Read ${fmtTokens(data.today.cacheReadTokens)}`;
    $('ov-today-in').textContent = fmtTokens(data.today.inputTokens);
    $('ov-today-out').textContent = `Out ${fmtTokens(data.today.outputTokens)}`;

    $('ov-all-total').textContent = fmtTokens(data.allTime.totalTokens);
    $('ov-all-convs').textContent = `${data.allTime.conversations} chats`;
    const hasAllCost = Boolean(data.allTimeCost?.pricedTurns > 0);
    $('ov-all-cost').textContent = hasAllCost ? `≈ ${fmtUsd(data.allTimeCost.totalUsd)}` : '—';
    $('ov-all-cost-wrap').title = formatCostTooltip(data.allTimeCost);
    const allRateEl = $('ov-all-rate');
    allRateEl.textContent = fmtPct(data.allTime.overallCacheRate);
    allRateEl.className = `perf-val ${data.allTime.totalTokens > 0 ? 'cache-tone' : ''}`;
    renderRecent(data);
  }

  function renderRecent(data) {
    const byToday = overviewSort === 'today';
    const items = byToday ? data.todayByInput || [] : data.recent || [];
    $('recent-metric').textContent = byToday ? 'Input today' : 'Total / cache';
    const empty = $('recent-empty');
    empty.hidden = items.length > 0;
    if (!items.length) empty.textContent = byToday ? 'No new input recorded today.' : 'No conversation usage recorded.';

    const maxMetric = items.reduce(
      (max, item) => Math.max(max, byToday ? (item.todayInputTokens || 0) : (item.totalTokens || 0)),
      0,
    );

    const activeConv = currentConvId();
    const list = $('recent-list');
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    let nextFocus;
    const frag = document.createDocumentFragment();

    for (const item of items) {
      const isCurrent = item.conversationId === activeConv;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `recent-item${isCurrent ? ' current' : ''}`;
      btn.dataset.conversationId = item.conversationId;
      btn.dataset.storeId = item.storeId;
      if (focused?.dataset.conversationId === item.conversationId && focused.dataset.storeId === item.storeId) {
        nextFocus = btn;
      }
      const sessionTarget = {
        conversationId: item.conversationId,
        storeId: item.storeId,
        storeLabel: item.storeLabel,
        title: item.title,
        isCurrent,
      };
      btn.addEventListener('click', () => {
        if (window.sidecar?.ui?.toggleConversation) {
          window.sidecar.ui.toggleConversation(item.conversationId);
        }
      });
      btn.addEventListener('pointerdown', (event) => {
        if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
          pendingContextMenu = {
            target: sessionTarget,
            x: event.clientX,
            y: event.clientY,
          };
        }
      });
      btn.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (pendingContextMenu) return;
        const rect = btn.getBoundingClientRect();
        const x = event.clientX || rect.left + rect.width / 2;
        const y = event.clientY || rect.top + rect.height / 2;
        requestAnimationFrame(() => openSessionMenu({ clientX: x, clientY: y }, sessionTarget));
      });

      const mainRow = document.createElement('div');
      mainRow.className = 'recent-main';

      const left = document.createElement('div');
      left.className = 'recent-left';

      const titleRow = document.createElement('div');
      titleRow.className = 'recent-title-row';
      if (isCurrent) {
        const dot = document.createElement('span');
        dot.className = 'current-dot';
        dot.setAttribute('aria-hidden', 'true');
        titleRow.append(dot);
      }
      const title = document.createElement('span');
      title.className = 'recent-title';
      title.textContent = item.title;
      title.title = item.title;
      titleRow.append(title);

      const sub = document.createElement('span');
      sub.className = 'recent-sub';
      const tag = document.createElement('span');
      const srcClass = item.source === 'cli' ? ' src-cli' : item.source === 'ide' ? ' src-ide' : '';
      tag.className = `source-tag${srcClass}`;
      tag.textContent = item.storeLabel;
      const metaText = document.createTextNode(
        `Ctx ${item.contextTokens == null ? '—' : fmtTokens(item.contextTokens)} · ${item.turns} turns`,
      );
      sub.append(tag, metaText);
      left.append(titleRow, sub);

      const right = document.createElement('div');
      right.className = 'recent-right';
      const metricVal = byToday ? item.todayInputTokens : item.totalTokens;
      const rTop = document.createElement('span');
      rTop.className = 'row-primary';
      rTop.textContent = fmtTokens(metricVal);
      const rSub = document.createElement('span');
      const isLowCache = !byToday && item.cacheRate < OVERVIEW_LOW_CACHE_THRESHOLD;
      if (byToday) {
        rSub.className = 'row-secondary';
        if (item.todayCostUsd != null) {
          const costSpan = document.createElement('span');
          costSpan.className = 'cost-inline';
          costSpan.textContent = fmtUsd(item.todayCostUsd);
          rSub.append(costSpan, ` · Total ${fmtTokens(item.totalTokens)}`);
        } else {
          rSub.textContent = `Total ${fmtTokens(item.totalTokens)}`;
        }
      } else {
        rSub.className = 'row-secondary';
        const cacheSpan = document.createElement('span');
        cacheSpan.className = isLowCache ? 'warn-tone' : 'cache-tone';
        cacheSpan.textContent = `Cache ${fmtPct(item.cacheRate)}`;
        if (item.costUsd != null) {
          const costSpan = document.createElement('span');
          costSpan.className = 'cost-inline';
          costSpan.textContent = fmtUsd(item.costUsd);
          rSub.append(cacheSpan, ' · ', costSpan);
        } else {
          rSub.append(cacheSpan);
        }
      }
      right.append(rTop, rSub);

      mainRow.append(left, right);
      btn.append(mainRow);

      if (maxMetric > 0) {
        const shareTrack = document.createElement('div');
        shareTrack.className = 'recent-share-track';
        shareTrack.setAttribute('aria-hidden', 'true');
        const fill = document.createElement('span');
        fill.className = 'recent-share-fill';
        const pct = Math.max(3, Math.round((metricVal / maxMetric) * 100));
        fill.style.inlineSize = `${pct}%`;
        shareTrack.append(fill);
        btn.append(shareTrack);
      }

      frag.appendChild(btn);
    }

    list.replaceChildren(frag);
    if (focused) (nextFocus || $('tab-btn-overview')).focus({ preventScroll: true });
  }

  async function pollConversation() {
    const convId = currentConvId();
    if (!convId) {
      renderConversation({ conversationId: convId, found: false });
      setLive(true, 'Idle');
      return;
    }

    const etag = lastPayload?.conversationId === convId ? lastEtag : '';

    try {
      const res = await post('/api/metrics', { conversationId: convId, etag });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (currentConvId() !== convId) return;
      if (activeTab === 'conv') setLive(true, 'Live');
      if (data.unchanged) return;
      lastEtag = data.etag || '';
      renderConversation(data);
    } catch {
      if (activeTab === 'conv' && currentConvId() === convId) setLive(false, 'Reconnecting');
    }
  }

  async function pollOverview() {
    const request = ++overviewRequest;
    try {
      const res = await post('/api/overview', { etag: overviewEtag });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (request !== overviewRequest) return;
      if (activeTab === 'overview') {
        const incomplete = data.unavailableStores?.length > 0;
        setLive(!incomplete, incomplete ? 'Some local stores unavailable' : 'Live');
      }
      if (data.unchanged) return;
      overviewEtag = data.etag || '';
      renderOverview(data);
    } catch {
      if (request !== overviewRequest) return;
      if (activeTab === 'overview') setLive(false, 'Reconnecting');
    }
  }

  async function tick() {
    const tab = activeTab;
    if (document.hidden || pendingTabs.has(tab)) return;
    pendingTabs.add(tab);
    try {
      if (tab === 'conv') await pollConversation();
      else await pollOverview();
    } finally {
      pendingTabs.delete(tab);
    }
  }

  function restartPolling() {
    clearInterval(pollTimer);
    if (document.hidden) return;
    tick();
    pollTimer = setInterval(tick, activeTab === 'conv' ? 1500 : 10_000);
  }

  function switchTab(nextTab) {
    activeTab = nextTab;
    const isConv = nextTab === 'conv';
    $('tab-btn-conv').classList.toggle('active', isConv);
    $('tab-btn-conv').setAttribute('aria-selected', String(isConv));
    $('tab-btn-conv').tabIndex = isConv ? 0 : -1;

    $('tab-btn-overview').classList.toggle('active', !isConv);
    $('tab-btn-overview').setAttribute('aria-selected', String(!isConv));
    $('tab-btn-overview').tabIndex = isConv ? -1 : 0;

    $('panel-conv').hidden = !isConv;
    $('panel-overview').hidden = isConv;
    restartPolling();
  }

  function setOverviewSort(nextSort) {
    if (overviewSort === nextSort) return;
    overviewSort = nextSort;
    const isRecent = nextSort === 'recent';
    $('sort-btn-recent').classList.toggle('active', isRecent);
    $('sort-btn-recent').setAttribute('aria-pressed', String(isRecent));
    $('sort-btn-today').classList.toggle('active', !isRecent);
    $('sort-btn-today').setAttribute('aria-pressed', String(!isRecent));
    if (lastOverview) renderRecent(lastOverview);
  }

  $('tab-btn-conv').addEventListener('click', () => switchTab('conv'));
  $('tab-btn-overview').addEventListener('click', () => switchTab('overview'));
  $('tab-btn-conv').parentElement.addEventListener('keydown', (event) => {
    let nextTab;
    switch (event.key) {
      case 'Home': nextTab = 'conv'; break;
      case 'End': nextTab = 'overview'; break;
      case 'ArrowLeft':
      case 'ArrowRight': nextTab = activeTab === 'conv' ? 'overview' : 'conv'; break;
      default: return;
    }
    event.preventDefault();
    switchTab(nextTab);
    $(`tab-btn-${nextTab}`).focus();
  });

  $('ctx-limit-select').addEventListener('change', () => {
    if (lastPayload?.found) renderContext(lastPayload);
  });

  $('changes-only').addEventListener('click', () => {
    changesOnly = !changesOnly;
    $('changes-only').setAttribute('aria-checked', String(changesOnly));
    visibleTurns = PAGE_SIZE;
    renderStream(lastPayload?.turns || []);
  });

  $('switches-only').addEventListener('click', () => {
    switchesOnly = !switchesOnly;
    $('switches-only').setAttribute('aria-checked', String(switchesOnly));
    visibleTurns = PAGE_SIZE;
    renderStream(lastPayload?.turns || []);
  });

  $('load-more').addEventListener('click', () => {
    visibleTurns += PAGE_SIZE;
    renderStream(lastPayload?.turns || [], true);
  });

  function showToast(message, isError = false) {
    const toast = $('action-toast');
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2600);
  }

  function openSessionMenu(event, target) {
    menuTarget = target;
    const menu = $('session-menu');
    const anchor = $('menu-anchor');
    const delBtn = $('menu-delete');

    delBtn.disabled = target.isCurrent;
    delBtn.textContent = target.isCurrent ? 'Cannot delete the active conversation' : 'Delete local files…';

    if (menu.matches(':popover-open')) {
      menu.hidePopover();
    }

    const x = event.clientX;
    const y = event.clientY;
    if (CSS.supports('position-area', 'block-end span-inline-end')) {
      anchor.style.left = `${x}px`;
      anchor.style.top = `${y}px`;
      menu.style.removeProperty('left');
      menu.style.removeProperty('top');
      menu.showPopover({ source: anchor });
    } else {
      menu.showPopover();
      const rect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }
    $('menu-open').focus({ preventScroll: true });
  }

  async function executeDelete(target) {
    try {
      const res = await post('/api/delete-conversation', {
        conversationId: target.conversationId,
        source: target.source,
        activeConversationId: currentConvId(),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.ok) {
        const msg = res.status === 404 && !payload.error
          ? 'Restart Token Monitor from Customizations.'
          : (payload.error || `HTTP ${res.status}`);
        throw new Error(msg);
      }
      overviewEtag = '';
      await pollOverview();
      showToast('Local conversation files deleted.');
    } catch (err) {
      showToast(`Could not delete local files: ${err.message || 'Unknown error'}`, true);
    }
  }

  $('menu-open').addEventListener('click', () => {
    const target = menuTarget;
    $('session-menu').hidePopover();
    if (target && window.sidecar?.ui?.toggleConversation) {
      window.sidecar.ui.toggleConversation(target.conversationId);
    }
  });

  $('menu-delete').addEventListener('click', () => {
    const target = menuTarget;
    $('session-menu').hidePopover();
    if (!target || target.isCurrent) return;
    pendingDelete = target;
    const targetEl = $('delete-dialog-target');
    targetEl.textContent = target.title;
    targetEl.title = target.title;
    $('delete-dialog').showModal();
  });

  $('delete-dialog').addEventListener('close', () => {
    const dialog = $('delete-dialog');
    const result = dialog.returnValue;
    dialog.returnValue = '';
    const target = pendingDelete;
    pendingDelete = null;
    if (result === 'delete' && target) {
      executeDelete(target);
    }
  });

  window.addEventListener('pointerup', (event) => {
    if (!pendingContextMenu) return;
    const pending = pendingContextMenu;
    pendingContextMenu = null;
    const x = event.clientX || pending.x;
    const y = event.clientY || pending.y;
    // Open after pointerup default light-dismiss finishes so macOS right-click stays open.
    requestAnimationFrame(() => openSessionMenu({ clientX: x, clientY: y }, pending.target));
  });
  window.addEventListener('pointercancel', () => { pendingContextMenu = null; });
  window.addEventListener('blur', () => { pendingContextMenu = null; });

  $('sort-btn-recent').addEventListener('click', () => setOverviewSort('recent'));
  $('sort-btn-today').addEventListener('click', () => setOverviewSort('today'));

  document.addEventListener('visibilitychange', restartPolling);
  restartPolling();
  window.addEventListener('beforeunload', () => clearInterval(pollTimer));
})();
