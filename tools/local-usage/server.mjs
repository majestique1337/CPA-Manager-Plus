#!/usr/bin/env node
// Aggregates local Claude Code + Codex session logs into daily usage rows and serves them
// on 127.0.0.1 so the dashboard can show spend, trend, models, projects and activity without
// any proxy traffic. No dependencies. Read-only on ~/.claude and ~/.codex.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const PORT = Number(process.env.LOCAL_USAGE_PORT ?? 18318);
const REFRESH_MS = 5 * 60_000;
const WINDOW_DAYS = 400;
const HISTORY_PATH = join(homedir(), '.local', 'share', 'cpamp-local-usage', 'history.json');
const CLAUDE_DIR = join(homedir(), '.claude', 'projects');
const CODEX_DIR = join(homedir(), '.codex', 'sessions');

// $ per million tokens: [input, output]. Cache read = 0.1x input, cache write = 1.25x input.
// Prices for models newer than this table are guesses from the closest family, hence "estimated".
const priceFor = (model) => {
  const m = model.toLowerCase();
  if (/opus-(4-[5-9]|[5-9])/.test(m)) return [5, 25];
  if (m.includes('opus')) return [15, 75];
  if (m.includes('sonnet')) return [3, 15];
  if (/haiku-([4-9])/.test(m)) return [1, 5];
  if (m.includes('haiku')) return [0.8, 4];
  if (/gpt|codex|^o\d/.test(m)) return [1.25, 10];
  return [3, 15];
};

const costOf = (r) => {
  const [pin, pout] = priceFor(r.model);
  return (r.in * pin + r.out * pout + r.cr * pin * 0.1 + r.cw * pin * 1.25) / 1e6;
};

const projectName = (cwd) => {
  if (!cwd) return 'Unknown';
  if (cwd.includes('/.t3/scratch/')) return 'T3 scratch';
  if (cwd.includes('Application Support/Claude')) return 'Claude desktop';
  if (cwd === homedir()) return 'Home';
  return basename(cwd) || 'Unknown';
};

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function* walk(dir, minMtime) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, minMtime);
    else if (entry.name.endsWith('.jsonl')) {
      const info = await stat(full);
      if (info.mtimeMs >= minMtime) yield { path: full, key: `${full}:${info.size}:${info.mtimeMs}` };
    }
  }
}

async function eachLine(path, needles, onLine) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (needles.some((n) => line.includes(n))) {
      try {
        onLine(JSON.parse(line));
      } catch {
        // partially written line at the tail of a live session
      }
    }
  }
}

async function parseClaude(path) {
  const seen = new Map();
  await eachLine(path, ['"usage"'], (o) => {
    const msg = o.message;
    if (o.type !== 'assistant' || !msg?.usage || !msg.model || msg.model.startsWith('<')) return;
    const u = msg.usage;
    const id = `${msg.id}:${o.requestId ?? ''}`;
    // streaming writes the same message several times; the last write has the final counts
    seen.set(id, {
      id,
      ts: Date.parse(o.timestamp),
      src: 'claude',
      model: msg.model,
      project: projectName(o.cwd),
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cr: u.cache_read_input_tokens ?? 0,
      cw: u.cache_creation_input_tokens ?? 0,
    });
  });
  return [...seen.values()];
}

async function parseCodex(path) {
  const records = [];
  let model = 'codex';
  let project = 'Unknown';
  let prev = { input: 0, cached: 0, output: 0 };
  await eachLine(path, ['"turn_context"', '"token_count"'], (o) => {
    const p = o.payload;
    if (o.type === 'turn_context' && p) {
      model = p.model ?? model;
      project = projectName(p.cwd);
      return;
    }
    const total = p?.type === 'token_count' ? p.info?.total_token_usage : null;
    if (!total) return;
    const cur = {
      input: total.input_tokens ?? 0,
      cached: total.cached_input_tokens ?? 0,
      output: total.output_tokens ?? 0,
    };
    // a drop means the counter restarted (compaction/resume): treat the new total as fresh usage
    const reset = cur.input < prev.input || cur.output < prev.output;
    const d = reset ? cur : { input: cur.input - prev.input, cached: cur.cached - prev.cached, output: cur.output - prev.output };
    prev = cur;
    if (d.input + d.output <= 0) return;
    records.push({
      id: null,
      ts: Date.parse(o.timestamp),
      src: 'codex',
      model,
      project,
      in: Math.max(0, d.input - d.cached),
      out: d.output,
      cr: d.cached,
      cw: 0,
    });
  });
  return records;
}

const tokensOf = (r) => r.in + r.out + r.cr + r.cw;

// Claude Code deletes old transcripts. Keep our own daily rows so history outlives the logs: per day we
// keep whichever copy (stored or freshly scanned) saw more tokens, which also covers half-deleted days.
async function mergeHistory(fresh) {
  let stored = [];
  try {
    stored = JSON.parse(await readFile(HISTORY_PATH, 'utf8')).rows ?? [];
  } catch {
    // first run
  }
  const byDate = (rows) => {
    const map = new Map();
    for (const r of rows) map.set(r.date, [...(map.get(r.date) ?? []), r]);
    return map;
  };
  const sum = (list) => list.reduce((n, r) => n + tokensOf(r), 0);
  const storedByDate = byDate(stored);
  const freshByDate = byDate(fresh);
  const merged = [];
  for (const date of new Set([...storedByDate.keys(), ...freshByDate.keys()])) {
    const a = storedByDate.get(date) ?? [];
    const b = freshByDate.get(date) ?? [];
    merged.push(...(sum(b) >= sum(a) ? b : a));
  }
  merged.sort((x, y) => x.date.localeCompare(y.date));
  try {
    await mkdir(join(HISTORY_PATH, '..'), { recursive: true });
    await writeFile(HISTORY_PATH, JSON.stringify({ rows: merged }));
  } catch (error) {
    console.error('could not save history', error.message);
  }
  return merged;
}

const fileCache = new Map();
let payload = { generatedAt: null, rows: [], scanning: true };

async function scan() {
  const minMtime = Date.now() - WINDOW_DAYS * 86_400_000;
  const live = new Set();
  const records = [];
  const jobs = [
    [CLAUDE_DIR, parseClaude],
    [CODEX_DIR, parseCodex],
  ];
  for (const [dir, parse] of jobs) {
    for await (const file of walk(dir, minMtime)) {
      live.add(file.key);
      if (!fileCache.has(file.key)) {
        try {
          fileCache.set(file.key, await parse(file.path));
        } catch (error) {
          console.error('skip', file.path, error.message);
          fileCache.set(file.key, []);
        }
      }
    }
  }
  for (const key of fileCache.keys()) if (!live.has(key)) fileCache.delete(key);

  // resumed Claude sessions copy earlier messages into new files, so dedupe by message id globally
  const claudeSeen = new Set();
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  const grouped = new Map();
  for (const list of fileCache.values()) {
    for (const r of list) {
      if (!Number.isFinite(r.ts) || r.ts < cutoff) continue;
      if (r.id) {
        if (claudeSeen.has(r.id)) continue;
        claudeSeen.add(r.id);
      }
      const date = dayKey(r.ts);
      const key = `${date}|${r.src}|${r.model}|${r.project}`;
      const row = grouped.get(key) ?? { date, src: r.src, model: r.model, project: r.project, in: 0, out: 0, cr: 0, cw: 0, cost: 0 };
      row.in += r.in;
      row.out += r.out;
      row.cr += r.cr;
      row.cw += r.cw;
      row.cost += costOf(r);
      grouped.set(key, row);
    }
  }
  const fresh = [...grouped.values()];
  for (const row of fresh) row.cost = Math.round(row.cost * 1e4) / 1e4;
  const rows = await mergeHistory(fresh);
  payload = { generatedAt: Date.now(), rows, estimatedPrices: true, scanning: false };
  console.log(`scanned ${live.size} files -> ${rows.length} rows`);
}

const refresh = () => scan().catch((error) => console.error('scan failed', error));
void refresh();
setInterval(refresh, REFRESH_MS).unref();

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/local-usage/data.json' || path === '/data.json') {
    const body = JSON.stringify(payload);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`local-usage on 127.0.0.1:${PORT}`));
