/**
 * Token Monitor sidecar backend.
 *
 * Reads Antigravity transcripts and can remove files from one selected local store.
 * The host's conversation index is read-only.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const MODEL_CONTEXT_LIMITS = [
  [/^gemini-/i, 1_000_000],
  [/^claude-/i, 200_000],
  [/^(gpt-5|gpt-4\.1|o3|o4)/i, 200_000],
  [/^gpt-4o/i, 128_000],
];

function inferContextLimit(model) {
  if (!model) return 1_000_000;
  for (const [re, limit] of MODEL_CONTEXT_LIMITS) {
    if (re.test(model)) return limit;
  }
  return 1_000_000;
}

// Published Google Gemini API paid-tier pricing (USD per 1M tokens).
// Implicit context caching on Gemini 4 provides a 95% discount on cached reads.
function lookupModelPricing(model, priceDate) {
  if (!model) return null;

  if (/^gemini-4-neon/i.test(model)) {
    return { input: 3.0, cacheRead: 0.15, output: 15.0 };
  }
  if (/^gemini-4-hydrogen/i.test(model)) {
    return { input: 1.5, cacheRead: 0.075, output: 7.5 };
  }
  if (/^gemini-4-(carbon|argon)/i.test(model)) {
    if (!priceDate) return null;
    return priceDate >= '2026-12-01'
      ? { input: 4.0, cacheRead: 0.20, output: 20.0 }
      : { input: 2.0, cacheRead: 0.10, output: 10.0 };
  }
  if (/^gemini-3\.(8|6)-flash/i.test(model)) {
    if (!priceDate) return null;
    return priceDate >= '2027-01-01'
      ? { input: 1.5, cacheRead: 0.075, output: 7.5 }
      : { input: 0.75, cacheRead: 0.0375, output: 3.75 };
  }
  if (/^gemini-3\.1-pro/i.test(model)) {
    return { input: 2.0, cacheRead: 0.20, output: 12.0 };
  }
  if (/^gemini-2\.5-pro/i.test(model)) {
    return { input: 1.25, cacheRead: 0.125, output: 10.0 };
  }
  if (/^gemini-2\.5-flash/i.test(model)) {
    return { input: 0.30, cacheRead: 0.03, output: 2.50 };
  }
  return null;
}

function costBucket() {
  return {
    inputUsd: 0,
    cacheReadUsd: 0,
    outputUsd: 0,
    totalUsd: 0,
    cacheSavedUsd: 0,
    pricedTurns: 0,
    unpricedTurns: 0,
  };
}

function priceTurn(model, priceDate, inputTokens, cacheReadTokens, outputTokens) {
  const rate = lookupModelPricing(model, priceDate);
  if (!rate) return { pricedTurns: 0, unpricedTurns: 1 };
  const inputUsd = (inputTokens * rate.input) / 1_000_000;
  const cacheReadUsd = (cacheReadTokens * rate.cacheRead) / 1_000_000;
  const outputUsd = (outputTokens * rate.output) / 1_000_000;
  const totalUsd = inputUsd + cacheReadUsd + outputUsd;
  const cacheSavedUsd = (cacheReadTokens * Math.max(0, rate.input - rate.cacheRead)) / 1_000_000;

  return { inputUsd, cacheReadUsd, outputUsd, totalUsd, cacheSavedUsd, pricedTurns: 1, unpricedTurns: 0 };
}

function mergeCost(target, src) {
  if (src.pricedTurns) {
    target.inputUsd += src.inputUsd;
    target.cacheReadUsd += src.cacheReadUsd;
    target.outputUsd += src.outputUsd;
    target.totalUsd += src.totalUsd;
    target.cacheSavedUsd += src.cacheSavedUsd;
  }
  target.pricedTurns += src.pricedTurns;
  target.unpricedTurns += src.unpricedTurns;
}

function formatModelLabel(model) {
  if (!model) return 'Unknown';
  return model
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function findPrimaryAppDataDir() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        return dirname(d);
      }
    }
  }
  return join(homedir(), '.gemini', 'antigravity');
}

function findAllAppDataDirs() {
  const base = join(homedir(), '.gemini');
  const desktop = join(base, 'antigravity');
  const primary = resolve(findPrimaryAppDataDir());
  const stores = [];
  const seen = new Set();
  for (const [path, source, storeLabel] of [
    [primary, 'desktop', primary === desktop ? 'desktop' : 'desktop · custom'],
    [desktop, 'desktop', primary === desktop ? 'desktop' : 'desktop · default'],
    [join(base, 'antigravity-cli'), 'cli', 'cli'],
    [join(base, 'antigravity-ide'), 'ide', 'ide'],
  ]) {
    try {
      const dir = realpathSync(path);
      if (seen.has(dir) || !fileStat(join(dir, 'brain'))) continue;
      seen.add(dir);
      const storeId = createHash('sha256').update(dir).digest('hex');
      stores.push({ dir, source, storeLabel, storeId });
    } catch (error) {
      if (error.code !== 'ENOENT') stores.push({ storeLabel });
    }
  }
  return stores;
}

// Keep compact summaries for history, but retain turns for only the last requested root.
const parseCache = new Map();
let detailCache;

function tokenCount(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function fileStat(path) {
  return statSync(path, { throwIfNoEntry: false });
}

function fileVersion(st) {
  return st ? `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : '';
}

function parseTranscript(filePath, { st, detail = false } = {}) {
  try {
    st ??= fileStat(filePath);
  } catch {
    return null;
  }
  if (!st?.isFile()) {
    parseCache.delete(filePath);
    if (detailCache?.filePath === filePath) detailCache = undefined;
    return null;
  }

  const etag = fileVersion(st);
  const cached = parseCache.get(filePath);
  if (cached?.etag === etag && !detail) return cached;
  if (detail && detailCache?.filePath === filePath && detailCache.parsed.etag === etag) {
    return detailCache.parsed;
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const turns = detail ? [] : null;
  const totals = usage();
  const byDay = new Map();
  let firstUserPrompt = '';
  let latestModel = '';
  let contextTokens = null;
  let prevPlanAction = null;
  let switchCount = 0;
  let totalPlanActions = 0;
  const modelBuckets = detail ? new Map() : null;
  const transcriptCost = costBucket();

  let pendingTurn;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // Ignore a partial last line while it is being written.
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;

    const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';
    const timestamp = Date.parse(createdAt);
    if (pendingTurn) {
      const delta = (timestamp - pendingTurn.timestamp) / 1000;
      if (delta > 0 && obj.type !== 'USER_INPUT') pendingTurn.turn.logGapSec = delta;
      pendingTurn = undefined;
    }
    if (!firstUserPrompt && obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
      const content = obj.content.match(/^\s*<USER_REQUEST>\s*([\s\S]*?)(?:<\/USER_REQUEST>|$)/i)?.[1] ?? obj.content;
      firstUserPrompt = content.replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    const hasTokenFields =
      obj.input_tokens !== undefined ||
      obj.output_tokens !== undefined ||
      obj.cache_read_tokens !== undefined;
    if (!hasTokenFields) continue;

    const inputTokens = tokenCount(obj.input_tokens);
    const cacheReadTokens = tokenCount(obj.cache_read_tokens);
    const outputTokens = tokenCount(obj.output_tokens);
    contextTokens = inputTokens + cacheReadTokens;
    const rawModel = typeof obj.model === 'string' ? obj.model : '';
    const model = rawModel || latestModel;
    const modelSwitch = detail && Boolean(latestModel && model !== latestModel);
    latestModel = model;

    const turnUsage = { turns: 1, inputTokens, cacheReadTokens, outputTokens };
    const priceDate = Number.isFinite(timestamp) && /^\d{4}-\d{2}-\d{2}/.test(createdAt)
      ? createdAt.slice(0, 10) : '';
    const turnCost = priceTurn(model, priceDate, inputTokens, cacheReadTokens, outputTokens);
    addUsage(totals, turnUsage);
    mergeCost(transcriptCost, turnCost);
    const day = localDateKey(timestamp);
    if (day) {
      let daily = byDay.get(day);
      if (!daily) {
        daily = { totals: usage(), cost: costBucket() };
        byDay.set(day, daily);
      }
      addUsage(daily.totals, turnUsage);
      mergeCost(daily.cost, turnCost);
    }
    if (!detail) continue;

    const tools = Array.isArray(obj.tool_calls)
      ? obj.tool_calls.map((t) => (typeof t?.name === 'string' ? t.name : '')).filter(Boolean)
      : [];
    const toolCount = tools.length;
    const planAction = tools.includes('exit_plan_mode')
      ? 'exit'
      : tools.includes('enter_plan_mode')
        ? 'enter'
        : null;
    if (planAction) totalPlanActions += 1;

    if (modelSwitch) switchCount += 1;

    if (model) {
      let bucket = modelBuckets.get(model);
      if (!bucket) {
        bucket = {
          model,
          modelLabel: formatModelLabel(model),
          ...usage(),
          exitPlanCount: 0,
          enterPlanCount: 0,
          receivedAfterExit: 0,
          receivedAfterEnter: 0,
          cost: costBucket(),
        };
        modelBuckets.set(model, bucket);
      }
      addUsage(bucket, turnUsage);
      mergeCost(bucket.cost, turnCost);
      if (planAction === 'exit') bucket.exitPlanCount += 1;
      if (planAction === 'enter') bucket.enterPlanCount += 1;
      if (modelSwitch && prevPlanAction === 'exit') bucket.receivedAfterExit += 1;
      if (modelSwitch && prevPlanAction === 'enter') bucket.receivedAfterEnter += 1;
    }

    const turn = {
      turnIndex: totals.turns,
      createdAt,
      model,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      contextTokens,
      cacheRate: contextTokens > 0 ? cacheReadTokens / contextTokens : 0,
      logGapSec: null,
      kind: toolCount > 0 ? 'Tool call' : 'Reply',
      tools,
      modelSwitch,
      planAction,
      costUsd: turnCost.totalUsd ?? null,
    };
    turns.push(turn);
    pendingTurn = { turn, timestamp };
    prevPlanAction = planAction;
  }

  const summary = {
    etag,
    title: firstUserPrompt,
    model: latestModel,
    modelLabel: formatModelLabel(latestModel),
    contextTokens,
    totals: summarizeUsage(totals),
    cost: transcriptCost,
    byDay,
  };
  parseCache.set(filePath, summary);
  if (!detail) return summary;

  const isMultiModel = modelBuckets.size >= 2;
  const isOrchestrated = isMultiModel && totalPlanActions > 0;
  const models = [...modelBuckets.values()]
    .map((b) => {
      const promptTokens = b.inputTokens + b.cacheReadTokens;
      const totalTokens = promptTokens + b.outputTokens;
      let role = null;
      let roleLabel = null;
      if (isOrchestrated) {
        const plannerScore = b.exitPlanCount + b.receivedAfterEnter;
        const executorScore = b.enterPlanCount + b.receivedAfterExit;
        if (plannerScore > executorScore) {
          role = 'planner';
          roleLabel = 'Plan';
        } else if (executorScore > plannerScore) {
          role = 'executor';
          roleLabel = 'Run';
        }
      }
      return {
        model: b.model,
        modelLabel: b.modelLabel,
        role,
        roleLabel,
        turns: b.turns,
        inputTokens: b.inputTokens,
        cacheReadTokens: b.cacheReadTokens,
        outputTokens: b.outputTokens,
        totalTokens,
        cacheRate: promptTokens > 0 ? b.cacheReadTokens / promptTokens : 0,
        costUsd: b.cost.pricedTurns > 0 ? b.cost.totalUsd : null,
        cacheSavedUsd: b.cost.pricedTurns > 0 ? b.cost.cacheSavedUsd : null,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const parsed = {
    ...summary,
    modelLimit: inferContextLimit(latestModel),
    latest: turns.at(-1) ?? null,
    turns,
    orchestration: { isMultiModel, isOrchestrated, modelCount: models.length, switchCount, models },
  };
  detailCache = { filePath, parsed };
  return parsed;
}

function transcriptPath(dir, convId) {
  return join(dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
}

const conversationIndexes = new Map();

function readConversationIndex(dir) {
  const path = join(dir, 'conversation_summaries.db');
  const dbStat = fileStat(path);
  const version = `${fileVersion(dbStat)}|${fileVersion(fileStat(`${path}-wal`))}`;
  const cached = conversationIndexes.get(dir);
  if (cached?.version === version) return cached;

  const parents = new Map();
  const names = new Map();
  const titles = new Map();
  if (dbStat) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const { conversation_id: id, parent_conversation_id: parent, agent_name: name } of db.prepare(
        "SELECT conversation_id, parent_conversation_id, agent_name FROM conversation_summaries WHERE parent_conversation_id <> ''",
      ).iterate()) {
        if (typeof id !== 'string' || typeof parent !== 'string' || !ID_RE.test(id) || !ID_RE.test(parent)) continue;
        parents.set(id, parent);
        if (typeof name === 'string' && name.trim()) names.set(id, name.trim());
      }
      const hasTitle = db.prepare('PRAGMA table_info(conversation_summaries)').all().some((col) => col.name === 'title');
      if (hasTitle) {
        for (const { conversation_id: id, title } of db.prepare(
          "SELECT conversation_id, title FROM conversation_summaries WHERE title <> ''",
        ).iterate()) {
          if (typeof id === 'string' && ID_RE.test(id) && typeof title === 'string' && title.trim()) {
            titles.set(id, title.trim());
          }
        }
      }
    } finally {
      db.close();
    }
  }

  const roots = new Map();
  const descendants = new Map();
  for (const id of parents.keys()) {
    const chain = new Set();
    let root = id;
    while (parents.has(root) && !roots.has(root) && !chain.has(root)) {
      chain.add(root);
      root = parents.get(root);
    }
    if (chain.has(root)) throw new Error('The conversation index contains a parent cycle.');
    root = roots.get(root) || root;
    for (const child of chain) roots.set(child, root);
    if (!descendants.has(root)) descendants.set(root, []);
    descendants.get(root).push(id);
  }
  for (const ids of descendants.values()) ids.sort();
  const index = { version, hasDb: Boolean(dbStat), roots, descendants, names, titles };
  conversationIndexes.set(dir, index);
  return index;
}

function usage() {
  return { turns: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}

function addUsage(bucket, totals) {
  bucket.turns += totals.turns;
  bucket.inputTokens += totals.inputTokens;
  bucket.cacheReadTokens += totals.cacheReadTokens;
  bucket.outputTokens += totals.outputTokens;
}

function summarizeUsage(bucket) {
  const promptTokens = bucket.inputTokens + bucket.cacheReadTokens;
  return {
    ...bucket,
    totalTokens: promptTokens + bucket.outputTokens,
    overallCacheRate: promptTokens > 0 ? bucket.cacheReadTokens / promptTokens : 0,
  };
}

function localDateKey(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let overviewCache;

function buildOverview(etag) {
  const todayKey = localDateKey(Date.now());
  const hash = createHash('sha256').update(todayKey);
  const snapshots = [];
  const unavailableStores = new Set();
  const livePaths = new Set();
  for (const { source, dir, storeId, storeLabel } of findAllAppDataDirs()) {
    if (!dir) {
      unavailableStores.add(storeLabel);
      continue;
    }
    let index;
    let ids;
    try {
      ids = readdirSync(join(dir, 'brain'), { withFileTypes: true })
        .filter(ent => ent.isDirectory() && ID_RE.test(ent.name)).map(ent => ent.name).sort();
      index = readConversationIndex(dir);
    } catch {
      unavailableStores.add(storeLabel);
      continue;
    }
    hash.update(storeId).update(storeLabel);
    const files = [];
    for (const id of ids) {
      const path = transcriptPath(dir, id);
      let st;
      try {
        st = fileStat(path);
      } catch {
        unavailableStores.add(storeLabel);
        continue;
      }
      if (!st?.isFile()) continue;
      livePaths.add(path);
      hash.update(`${id}:${index.roots.get(id) || id}:${index.titles.get(id) || ''}:${fileVersion(st)};`);
      files.push({ id, path, st });
    }
    snapshots.push({ source, storeId, storeLabel, index, files });
  }
  for (const path of parseCache.keys()) {
    if (!livePaths.has(path)) parseCache.delete(path);
  }
  if (detailCache && !livePaths.has(detailCache.filePath)) detailCache = undefined;

  const version = hash.digest('hex');
  if (!unavailableStores.size && overviewCache?.etag === version) {
    return etag === version ? { etag: version, unchanged: true } : overviewCache;
  }

  const today = { conversations: 0, ...usage() };
  const allTime = { conversations: 0, ...usage() };
  const todayCost = costBucket();
  const allTimeCost = costBucket();
  const recent = [];
  for (const { source, storeId, storeLabel, index, files } of snapshots) {
    const groups = new Map();
    for (const { id, path, st } of files) {
      const parsed = parseTranscript(path, { st });
      if (!parsed) {
        unavailableStores.add(storeLabel);
        continue;
      }
      const root = index.roots.get(id) || id;
      if (!groups.has(root)) {
        groups.set(root, {
          totals: usage(),
          cost: costBucket(),
          todayCost: costBucket(),
          today: usage(),
          activity: 0,
        });
      }
      const group = groups.get(root);
      if (root === id) group.main = parsed;
      if (parsed.totals.turns === 0) continue;
      group.activity = Math.max(group.activity, st.mtimeMs);
      addUsage(group.totals, parsed.totals);
      mergeCost(group.cost, parsed.cost);
      const daily = parsed.byDay.get(todayKey);
      if (daily) {
        addUsage(group.today, daily.totals);
        mergeCost(group.todayCost, daily.cost);
      }
    }
    for (const [id, group] of groups) {
      if (!group.totals.turns) continue;
      allTime.conversations += 1;
      if (group.today.turns) today.conversations += 1;
      addUsage(today, group.today);
      mergeCost(todayCost, group.todayCost);
      addUsage(allTime, group.totals);
      mergeCost(allTimeCost, group.cost);
      const totals = summarizeUsage(group.totals);
      recent.push({
        conversationId: id,
        source,
        storeId,
        storeLabel,
        title: index.titles.get(id) || group.main?.title || id.slice(0, 8),
        activity: group.activity,
        turns: totals.turns,
        contextTokens: group.main?.contextTokens ?? null,
        totalTokens: totals.totalTokens,
        todayInputTokens: group.today.inputTokens,
        cacheRate: totals.overallCacheRate,
        costUsd: group.cost.pricedTurns > 0 ? group.cost.totalUsd : null,
        todayCostUsd: group.todayCost.pricedTurns > 0 ? group.todayCost.totalUsd : null,
      });
    }
  }

  recent.sort((a, b) => b.activity - a.activity);
  const todayByInput = recent.filter(item => item.todayInputTokens > 0)
    .sort((a, b) => b.todayInputTokens - a.todayInputTokens || b.activity - a.activity);
  const visible = rows => rows.slice(0, 14).map(({ activity, ...item }) => item);
  const payload = {
    etag: unavailableStores.size ? '' : version,
    unavailableStores: [...unavailableStores],
    todayDate: todayKey,
    today: summarizeUsage(today),
    todayCost,
    allTime: summarizeUsage(allTime),
    allTimeCost,
    recent: visible(recent),
    todayByInput: visible(todayByInput),
  };
  overviewCache = payload.etag ? payload : undefined;
  return payload;
}

const app = new SidecarApp();

function apiError(status, error, details) {
  return new Response(JSON.stringify({ ok: false, error, ...details }), {
    status,
    contentType: 'application/json; charset=utf-8',
  });
}

function privateApi(path, handler) {
  // The SDK checks the UI token for POST, but allows any request when it is unset.
  app.api(path, (data) => {
    if (!process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN) return apiError(503, 'Antigravity has not configured a sidecar access token.');
    const result = handler(data);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      contentType: 'application/json; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
    });
  }, 'POST');
}

app.page('/', () => {
  try {
    return new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('Token Monitor UI is initializing…', {
      status: 503,
      contentType: 'text/plain; charset=utf-8',
    });
  }
});

for (const [route, [file, type]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => {
      try {
        return new Response(readFileSync(join(__dirname, file), 'utf-8'), {
          contentType: type,
          headers: { 'Cache-Control': 'no-store' },
        });
      } catch {
        return new Response('Not found', { status: 404, contentType: 'text/plain; charset=utf-8' });
      }
    },
    'GET',
  );
}

privateApi(
  '/api/metrics',
  (data) => {
    const convId =
      typeof data.conversationId === 'string' && data.conversationId
        ? data.conversationId
        : app.config.conversationId || '';

    if (!convId || !ID_RE.test(convId)) {
      return { conversationId: convId || null, found: false };
    }

    const stores = findAllAppDataDirs().filter(({ dir }) => dir);
    let hit = stores.find(({ dir }) => {
      try {
        return fileStat(transcriptPath(dir, convId))?.isFile();
      } catch {
        return false;
      }
    });
    let index;
    if (hit) {
      index = readConversationIndex(hit.dir);
    } else {
      for (const store of stores) {
        try {
          const candidate = readConversationIndex(store.dir);
          if (candidate.roots.has(convId) || candidate.descendants.has(convId)) {
            hit = store;
            index = candidate;
            break;
          }
        } catch {
          // An unreadable store must not hide a conversation in a healthy one.
        }
      }
    }
    if (!hit) return { conversationId: convId, found: false };

    const rootId = index.roots.get(convId) || convId;
    const parsed = parseTranscript(transcriptPath(hit.dir, rootId), { detail: true });
    const totals = usage();
    const convCost = costBucket();
    if (parsed) {
      addUsage(totals, parsed.totals);
      mergeCost(convCost, parsed.cost);
    }
    const descendants = index.descendants.get(rootId) || [];
    const subagents = [];
    const hash = createHash('sha256').update(JSON.stringify([hit.dir, convId, rootId, parsed?.etag]));
    for (const id of descendants) {
      const child = parseTranscript(transcriptPath(hit.dir, id));
      const name = index.names.get(id) || id.slice(0, 8);
      hash.update(JSON.stringify([id, name, child?.etag]));
      subagents.push({
        conversationId: id,
        name,
        modelLabel: child?.model ? child.modelLabel : null,
        turns: child?.totals.turns ?? null,
        totalTokens: child?.totals.totalTokens ?? null,
        costUsd: child?.cost.pricedTurns > 0 ? child.cost.totalUsd : null,
      });
      if (child) {
        addUsage(totals, child.totals);
        mergeCost(convCost, child.cost);
      }
    }
    if (!totals.turns) return { conversationId: convId, found: false };

    const etag = hash.digest('hex');
    if (data.etag === etag) return { conversationId: convId, found: true, unchanged: true, etag };
    subagents.sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1));

    return {
      conversationId: convId,
      found: true,
      model: parsed?.model,
      modelLabel: parsed?.modelLabel,
      modelLimit: parsed?.modelLimit,
      latest: parsed?.latest,
      turns: parsed?.turns,
      etag,
      totals: summarizeUsage(totals),
      cost: convCost,
      subagents,
      mainTokens: parsed?.totals.totalTokens || 0,
      orchestration: parsed?.orchestration || {
        isMultiModel: false,
        isOrchestrated: false,
        modelCount: 0,
        switchCount: 0,
        models: [],
      },
    };
  },
);

function deleteConversation({ conversationId, storeId, activeConversationId }) {
  if (typeof conversationId !== 'string' || !ID_RE.test(conversationId)) {
    return apiError(400, 'Invalid conversation ID.');
  }
  if (typeof storeId !== 'string' || !storeId) return apiError(400, 'Select a local store before deleting files.');
  const store = findAllAppDataDirs().find((candidate) => candidate.storeId === storeId);
  if (!store) return apiError(404, 'The selected local store was not found.');

  let index;
  try {
    index = readConversationIndex(store.dir);
  } catch {
    return apiError(409, 'Could not read the conversation index. No files were deleted.');
  }
  if (!index.hasDb) return apiError(409, 'The conversation index is missing, so subagent relationships cannot be checked. No files were deleted.');

  const rootId = index.roots.get(conversationId) || conversationId;
  const targetIds = new Set([rootId, ...(index.descendants.get(rootId) || [])]);
  const activeIds = new Set([activeConversationId, app.config.conversationId]
    .filter((id) => typeof id === 'string').map((id) => id.toLowerCase()));
  for (const id of targetIds) {
    if (activeIds.has(id.toLowerCase())) return apiError(400, 'Cannot delete files from the active conversation.');
  }

  const paths = [];
  for (const folder of ['annotations', 'conversations', 'brain']) {
    const dir = join(store.dir, folder);
    try {
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (!st) continue;
      if (!st.isDirectory()) return apiError(409, `${folder} is not a normal directory. No files were deleted.`);
      for (const name of readdirSync(dir)) {
        const id = folder === 'brain' ? name : name.split('.', 1)[0];
        if (targetIds.has(id)) paths.push(join(dir, name));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return apiError(409, `Could not read ${folder}. No files were deleted.`);
    }
  }
  if (!paths.length) return apiError(404, 'No local files found for this conversation.');

  let removedCount = 0;
  try {
    for (const path of paths) {
      rmSync(path, { recursive: true });
      removedCount += 1;
    }
  } catch {
    return apiError(500, `Deletion stopped after removing ${removedCount} items. Some local files may remain.`, {
      removedCount,
      removalStarted: true,
    });
  } finally {
    for (const id of targetIds) {
      const path = transcriptPath(store.dir, id);
      parseCache.delete(path);
      if (detailCache?.filePath === path) detailCache = undefined;
    }
    overviewCache = undefined;
  }
  return { ok: true, removedCount };
}

privateApi('/api/overview', (data) => buildOverview(data.etag));
privateApi('/api/delete-conversation', deleteConversation);

app.run();
