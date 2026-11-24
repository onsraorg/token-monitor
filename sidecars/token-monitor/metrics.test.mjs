import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Run with Node 24+ and the installed Antigravity SDK.
const loader = join(homedir(), '.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js');
const entry = fileURLToPath(new URL('./main.mjs', import.meta.url));
const root = 'aaaaaaaa';
const child = 'bbbbbbbb';
const grandchild = 'cccccccc';
// Same UTC date, opposite sides of local midnight (UTC-08:00).
const localDay = '2027-02-12';
const today = `${localDay}T08:00:01.000Z`;
const yesterday = `${localDay}T07:59:59.000Z`;
const line = (record) => `${JSON.stringify(record)}\n`;
const turn = (input, date = today, model) => line({ created_at: date, model, input_tokens: input, cache_read_tokens: 5, output_tokens: 1 });
const clock = `data:text/javascript,${encodeURIComponent(`import { mock } from 'node:test'; mock.timers.enable({ apis: ['Date'], now: Date.parse('${today}') });`)}`;

function testStore(t, { custom = false, activeId, token = 'test-ui-token' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'token-monitor-test-'));
  const desktop = join(home, '.gemini', 'antigravity');
  const store = custom ? join(home, 'custom-antigravity') : desktop;
  const data = join(store, 'sidecar_data', 'token-monitor');
  const databases = [];
  let server;
  let stopped;
  let url;
  t.after(async () => {
    if (server) {
      server.kill();
      await stopped;
    }
    for (const db of databases) db.close();
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(data, { recursive: true });

  const write = (rel, content, dir = store) => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const writeLog = (id, content, dir) => write(`brain/${id}/.system_generated/logs/transcript.jsonl`, content, dir);
  const openIndex = (dir = store) => {
    const db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
    databases.push(db);
    return db;
  };
  const createIndex = (db) => db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT NOT NULL, agent_name TEXT NOT NULL)`);

  async function start() {
    server = spawn(process.execPath, ['--import', loader, '--import', clock, entry], {
      env: {
        HOME: home, USERPROFILE: home, TMPDIR: home, TZ: 'Etc/GMT+8', ANTIGRAVITY_EXECUTABLE_DATA_DIR: data,
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1', ANTIGRAVITY_CSRF_TOKEN: 'test', ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
        ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
        ...(activeId && { ANTIGRAVITY_CONVERSATION_ID: activeId }),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    stopped = new Promise((resolve) => server.once('close', resolve));
    const logs = createInterface({ input: server.stdout });
    try {
      url = await new Promise((resolve, reject) => {
        server.once('error', reject);
        logs.on('line', (line) => {
          const address = line.match(/127\.0\.0\.1:\d+/)?.[0];
          if (address) resolve(`http://${address}`);
        });
        logs.once('close', () => reject(new Error('Sidecar exited before listening')));
      });
    } finally {
      logs.close();
    }
  }

  const request = (route, data = {}, { method = 'POST', auth = token } = {}) => fetch(`${url}/api/${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && { 'X-Sidecar-Token': auth }) },
    body: method === 'POST' ? JSON.stringify(data) : undefined,
    signal: t.signal,
  });
  const get = async (route, data) => {
    const response = await request(route, data);
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  };
  return { home, desktop, store, write, writeLog, openIndex, createIndex, start, request, get };
}

test('nested agent updates refresh root telemetry and local daily rankings', { timeout: 10_000 }, async (t) => {
  const { writeLog, openIndex, createIndex, start, get } = testStore(t);
  writeLog(root, line({ type: 'USER_INPUT', content: '\n<USER_REQUEST>\nRoot title\n</USER_REQUEST>\n<CONTEXT>extra context</CONTEXT>' }) + turn(10, yesterday));
  const grandchildLog = writeLog(grandchild, turn(20, today, 'gemini-4-neon-high') + line({ created_at: new Date(Date.parse(today) + 168_000).toISOString() }));
  const db = openIndex();
  createIndex(db);
  const parentOf = db.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?)');
  parentOf.run(grandchild, child, 'Nested worker');
  parentOf.run(child, root, '');
  await start();
  const original = await get('metrics', { conversationId: root });
  const overview = await get('overview');
  assert.equal(original.totals.totalTokens, 42);
  const expectedGrandchildCost = (20 * 3 + 5 * 0.15 + 1 * 15) / 1_000_000;
  assert.deepEqual(original.subagents, [
    { conversationId: grandchild, name: 'Nested worker', modelLabel: 'Gemini 4 Neon High', turns: 1, totalTokens: 26, costUsd: expectedGrandchildCost },
    { conversationId: child, name: child, modelLabel: null, turns: null, totalTokens: null, costUsd: null },
  ]);
  assert.equal(overview.today.totalTokens, 26);
  assert.equal(overview.recent[0].title, 'Root title');
  assert.equal(overview.todayDate, localDay);
  assert.deepEqual(overview.todayByInput.map(item => [item.conversationId, item.todayInputTokens]), [[root, 20]]);
  assert.equal(overview.allTime.conversations, 1);
  assert.equal((await get('overview', { etag: overview.etag })).unchanged, true);

  appendFileSync(grandchildLog, turn(30, today, 'claude-opus-5-5-high'));
  const updated = await get('metrics', { conversationId: root, etag: original.etag });
  const summary = await get('overview', { etag: overview.etag });
  assert.equal(updated.totals.totalTokens, 78);
  assert.equal(updated.totals.turns, 3);
  assert.equal(updated.mainTokens, 16);
  assert.equal(updated.latest.contextTokens, 15);
  assert.equal(updated.latest.logGapSec, null);
  assert.equal(updated.turns.length, 1);
  assert.deepEqual(updated.subagents[0], { conversationId: grandchild, name: 'Nested worker', modelLabel: 'Claude Opus 5 5 High', turns: 2, totalTokens: 62, costUsd: expectedGrandchildCost });
  assert.equal((await get('metrics', { conversationId: grandchild })).totals.totalTokens, 78);
  assert.equal(summary.today.totalTokens, 62);
  assert.equal(summary.today.conversations, 1);
  assert.deepEqual(summary.recent.map(item => [item.conversationId, item.totalTokens]), [[root, 78]]);
  assert.deepEqual(summary.todayByInput.map(item => [item.conversationId, item.todayInputTokens]), [[root, 50]]);

  parentOf.run(grandchild, child, 'Renamed worker');
  const renamed = await get('metrics', { conversationId: root, etag: updated.etag });
  assert.deepEqual(renamed.subagents.map(agent => agent.name), ['Renamed worker', child]);
  assert.equal((await get('metrics', { conversationId: root, etag: renamed.etag })).unchanged, true);

  writeLog(child, turn(100));
  const started = await get('metrics', { conversationId: root, etag: renamed.etag });
  assert.deepEqual(started.subagents.map(agent => [agent.name, agent.totalTokens]), [[child, 106], ['Renamed worker', 62]]);
  const beforeRegroup = await get('overview');

  // Metadata can change without either transcript changing, including in WAL mode.
  parentOf.run(grandchild, '', 'Renamed worker');
  const regrouped = await get('overview', { etag: beforeRegroup.etag });
  assert.equal(regrouped.allTime.conversations, 2);
  const separate = await get('metrics', { conversationId: grandchild });
  assert.equal(separate.turns[0].logGapSec, 168);
  assert.equal(separate.latest.logGapSec, null);

  const rival = 'dddddddd';
  writeLog(rival, turn(200_000, yesterday) + turn(25));
  writeLog('eeeeeeee', line({ created_at: today, input_tokens: 0, cache_read_tokens: 100_000 }));
  utimesSync(grandchildLog, 1, 1);
  for (let i = 0; i < 14; i++) writeLog(i.toString(16).padStart(8, '0'), turn(1000, yesterday));
  const ranked = await get('overview');
  assert.ok(!ranked.recent.some(item => item.conversationId === grandchild));
  assert.deepEqual(ranked.todayByInput.map(item => [item.conversationId, item.todayInputTokens]), [
    [root, 100], [grandchild, 50], [rival, 25],
  ]);
});

test('deletion checks the selected store before removing only its local files', { timeout: 10_000 }, async (t) => {
  const unrelated = '11111111';
  const { desktop, store, write, writeLog, openIndex, createIndex, start, request, get } = testStore(t, { custom: true, activeId: child });
  writeLog(unrelated, turn(10));
  const rootBrain = writeLog(root, turn(20));
  const childBrain = writeLog(grandchild, turn(30));
  const sameIdInDefault = writeLog(root, turn(99), desktop);
  writeLog(child, turn(1), desktop);
  const rootDb = write(`conversations/${root}.db`, 'db');
  const rootWal = write(`conversations/${root}.db-wal`, 'wal');
  const childPb = write(`conversations/${grandchild}.pb`, 'pb');
  const rootAnn = write(`annotations/${root}.pbtxt`, 'ann');

  const db = openIndex();
  createIndex(db);
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(grandchild, root, 'Worker');
  const defaultDb = openIndex(desktop);
  createIndex(defaultDb);
  defaultDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(child, root, 'Active worker');
  await start();

  const overview = await get('overview');
  const customRow = overview.recent.find((row) => row.conversationId === root && row.totalTokens === 62);
  const defaultRow = overview.recent.find((row) => row.conversationId === root && row.totalTokens === 112);
  const target = { conversationId: root, storeId: customRow.storeId };
  assert.equal((await request('delete-conversation', target, { auth: '' })).status, 401);
  assert.equal((await request('delete-conversation', { conversationId: root })).status, 400);
  assert.equal((await request('delete-conversation', { ...target, conversationId: '../brain' })).status, 400);
  assert.equal((await request('delete-conversation', { ...target, storeId: defaultRow.storeId })).status, 400);
  assert.equal((await request('delete-conversation', { ...target, activeConversationId: grandchild })).status, 400);
  assert.ok(existsSync(rootBrain) && existsSync(sameIdInDefault));

  const annotations = join(store, 'annotations');
  renameSync(annotations, `${annotations}-backup`);
  write('annotations', 'not a directory');
  assert.equal((await request('delete-conversation', target)).status, 409);
  for (const path of [rootBrain, childBrain, rootDb, rootWal, childPb]) assert.ok(existsSync(path));
  rmSync(annotations);
  renameSync(`${annotations}-backup`, annotations);

  const locked = dirname(childBrain);
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    chmodSync(locked, 0o500);
    try {
      const partial = await request('delete-conversation', target);
      assert.equal(partial.status, 500);
      const payload = await partial.json();
      assert.equal(payload.removalStarted, true);
      assert.ok(payload.removedCount > 0);
      assert.ok(!existsSync(rootAnn) && existsSync(childBrain) && existsSync(sameIdInDefault));
    } finally {
      chmodSync(locked, 0o700);
    }
  }

  const body = await get('delete-conversation', target);
  assert.equal(body.ok, true);
  for (const path of [rootBrain, childBrain, rootDb, rootWal, childPb, rootAnn]) assert.ok(!existsSync(path));
  assert.ok(existsSync(sameIdInDefault));
  assert.equal(db.prepare('SELECT parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?').get(grandchild).parent_conversation_id, root);
  const after = await get('overview', { etag: overview.etag });
  assert.deepEqual(after.recent.filter((row) => row.conversationId === root).map((row) => [row.storeId, row.totalTokens]), [[defaultRow.storeId, 112]]);
  assert.ok(after.recent.some((row) => row.conversationId === unrelated));
});

test('overview keeps healthy sources visible and recovers when a broken index is initialized', { timeout: 10_000 }, async (t) => {
  const { home, writeLog, openIndex, createIndex, start, request, get } = testStore(t);
  const cli = join(home, '.gemini', 'antigravity-cli');
  const rootLog = writeLog(root, turn(10));
  writeLog(child, turn(20), cli);
  const cliDb = openIndex(cli);
  await start();
  const incomplete = await get('overview');
  assert.deepEqual(incomplete.unavailableStores, ['cli']);
  assert.deepEqual(incomplete.recent.map((row) => row.conversationId), [root]);
  assert.equal(incomplete.etag, '');
  createIndex(cliDb);
  const complete = await get('overview');
  assert.deepEqual(complete.unavailableStores, []);
  assert.deepEqual(complete.recent.map((row) => row.conversationId).sort(), [root, child]);
  const { storeId } = complete.recent.find((row) => row.conversationId === root);
  assert.equal((await request('delete-conversation', { conversationId: root, storeId })).status, 409);
  assert.ok(existsSync(rootLog));
});

test('history routes require the SDK UI token and reject reads when it is not configured', { timeout: 10_000 }, async (t) => {
  const locked = testStore(t);
  const unconfigured = testStore(t, { token: '' });
  locked.writeLog(root, turn(10));
  unconfigured.writeLog(root, turn(10));
  await locked.start();
  await unconfigured.start();
  for (const route of ['metrics', 'overview']) {
    const data = { conversationId: root };
    assert.equal((await locked.request(route, data, { method: 'GET', auth: '' })).status, 405);
    assert.equal((await locked.request(route, data, { auth: '' })).status, 401);
    assert.equal((await locked.request(route, data, { auth: 'wrong-token' })).status, 401);
    assert.equal((await locked.request(route, data)).status, 200);
    assert.equal((await unconfigured.request(route, data)).status, 503);
  }
});

test('multi-model orchestration reports roles, switches, and plan actions', { timeout: 10_000 }, async (t) => {
  const { writeLog, start, get } = testStore(t);
  const step = (obj) => line({ created_at: today, ...obj });
  writeLog(root,
    step({ model: 'gemini-4-carbon-medium', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 100, tool_calls: [{ name: 'read_file' }] }) +
    step({ model: 'gemini-4-carbon-medium', input_tokens: 200, cache_read_tokens: 900, output_tokens: 80, tool_calls: [{ name: 'exit_plan_mode' }] }) +
    step({ model: 'gemini-4-hydrogen-xhigh', input_tokens: 1200, cache_read_tokens: 0, output_tokens: 150, tool_calls: [{ name: 'edit_file' }] }) +
    step({ model: 'gemini-4-hydrogen-xhigh', input_tokens: 300, cache_read_tokens: 1000, output_tokens: 90, tool_calls: [{ name: 'enter_plan_mode' }] }) +
    step({ model: 'gemini-4-carbon-medium', input_tokens: 1400, cache_read_tokens: 0, output_tokens: 60 }),
  );
  await start();

  const { orchestration, turns } = await get('metrics', { conversationId: root });
  assert.equal(orchestration.isMultiModel, true);
  assert.equal(orchestration.isOrchestrated, true);
  assert.equal(orchestration.modelCount, 2);
  assert.equal(orchestration.switchCount, 2);

  const planner = orchestration.models.find((m) => m.model === 'gemini-4-carbon-medium');
  const executor = orchestration.models.find((m) => m.model === 'gemini-4-hydrogen-xhigh');
  assert.equal(planner.role, 'planner');
  assert.equal(planner.roleLabel, 'Plan');
  assert.equal(planner.turns, 3);
  assert.equal(executor.role, 'executor');
  assert.equal(executor.roleLabel, 'Run');
  assert.equal(executor.turns, 2);

  assert.equal(turns[1].planAction, 'exit');
  assert.equal(turns[2].modelSwitch, true);
  assert.equal(turns[3].planAction, 'enter');
  assert.equal(turns[4].modelSwitch, true);
  assert.deepEqual(turns[0].tools, ['read_file']);
});

test('API pricing is date-stable, preserves valid counts, and never emits invalid numbers', { timeout: 10_000 }, async (t) => {
  const { writeLog, start, get } = testStore(t);
  const counts = { input_tokens: 1_000_000, cache_read_tokens: 1_000_000, output_tokens: 100_000 };
  writeLog(root,
    line({ ...counts, created_at: '2026-11-24T10:00:00Z', model: 'gemini-4-neon-high' }) +
    line({ ...counts, created_at: '2026-11-30T23:59:59Z', model: 'gemini-4-carbon-medium' }) +
    line({ ...counts, created_at: '2026-12-01T00:00:00Z', model: 'gemini-4-carbon-medium' }) +
    line({ created_at: today, model: 'gemini-4-hydrogen-xhigh', input_tokens: '1000000', cache_read_tokens: '1e400', output_tokens: 200_000 }) +
    line({ model: 'gemini-4-carbon-medium', input_tokens: 1_000_000, cache_read_tokens: -400, output_tokens: null }),
  );
  await start();

  const overview = await get('overview');
  const metrics = await get('metrics', { conversationId: root });
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${expected}, got ${actual}`);
  near(metrics.turns[0].costUsd, 4.65);
  near(metrics.turns[1].costUsd, 3.10);
  near(metrics.turns[2].costUsd, 6.20);
  near(metrics.turns[3].costUsd, 3.00);
  assert.equal(metrics.turns[4].costUsd, null);
  assert.equal(metrics.cost.unpricedTurns, 1);
  assert.equal(metrics.totals.cacheReadTokens, 3_000_000);
  assert.equal(metrics.totals.inputTokens, 5_000_000);
  near(metrics.cost.totalUsd, 16.95);
  near(metrics.cost.cacheSavedUsd, 8.55);

  const carbon = metrics.orchestration.models.find((m) => m.model === 'gemini-4-carbon-medium');
  near(carbon.costUsd, 9.30);
  near(overview.allTimeCost.totalUsd, 16.95);
  near(overview.todayCost.totalUsd, 3.00);
  near(overview.recent[0].costUsd, 16.95);
  near(overview.recent[0].todayCostUsd, 3.00);
});

test('overview prefers conversation_summaries.title to match Antigravity sidebar and refreshes on rename', { timeout: 10_000 }, async (t) => {
  const { writeLog, openIndex, start, get } = testStore(t);
  writeLog(root, line({ type: 'USER_INPUT', content: '<USER_REQUEST>/Users/example/raw-prompt</USER_REQUEST>' }) + turn(10));
  writeLog(child, line({ type: 'USER_INPUT', content: '<USER_REQUEST>Fallback Prompt Title</USER_REQUEST>' }) + turn(10));

  const db = openIndex();
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT ''
    )`);
  const upsert = db.prepare('INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, parent_conversation_id, agent_name) VALUES (?, ?, ?, ?)');
  upsert.run(root, 'Example Workspace Conversation', '', '');
  upsert.run(child, '', '', '');

  await start();
  const initial = await get('overview');
  const titleMap = Object.fromEntries(initial.recent.map((r) => [r.conversationId, r.title]));
  assert.equal(titleMap[root], 'Example Workspace Conversation');
  assert.equal(titleMap[child], 'Fallback Prompt Title');

  // Rename title in WAL mode without modifying transcript.jsonl -> overview etag must refresh
  upsert.run(root, 'Renamed Sidebar Title', '', '');
  const renamed = await get('overview', { etag: initial.etag });
  assert.equal(renamed.unchanged, undefined);
  const renamedMap = Object.fromEntries(renamed.recent.map((r) => [r.conversationId, r.title]));
  assert.equal(renamedMap[root], 'Renamed Sidebar Title');
});
