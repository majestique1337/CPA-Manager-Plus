// Fixed, disposable AQ-04 experiments. Raw receipts never leave this module.
import net from 'node:net';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const MiB = 1024 * 1024;
const QUEUE = '/observability/usage/queue';
const CONFIG = '/config/observability/usage/';
const STATS = 'usage-statistics-enabled';
const RETENTION = 'redis-usage-queue-retention-seconds';
const fault = (code = 'SETUP_FAILED') => Object.assign(new Error(code), { code });
export const requireUsage = (condition, code) => {
  if (!condition) throw fault(code);
};
const wait = async (ms, signal) => {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw fault('CANCELLED');
    throw error;
  }
};

export function usageBudget(pressure = false) {
  let pops = 0,
    records = 0,
    produced = 0,
    bytes = 0;
  return {
    pop(count = 1) {
      requireUsage(
        Number.isInteger(count) && count > 0 && count <= 16 && ++pops <= 32,
        'INPUT_LIMIT'
      );
    },
    receive(items) {
      requireUsage(Array.isArray(items), 'SETUP_FAILED');
      records += items.length;
      bytes += Buffer.byteLength(JSON.stringify(items));
      requireUsage(records <= (pressure ? 1024 : 512) && bytes <= 32 * MiB, 'INPUT_LIMIT');
    },
    produce(count) {
      requireUsage(
        Number.isInteger(count) && count > 0 && (produced += count) <= (pressure ? 1024 : 512),
        'INPUT_LIMIT'
      );
    },
  };
}

export function projectReceipts(receipts, binding, currentBinding, captured = false) {
  requireUsage(Array.isArray(receipts) && receipts.length <= 1024, 'INPUT_LIMIT');
  const unique = new Set(receipts);
  return {
    received: receipts.length,
    unique: unique.size,
    duplicates: receipts.length - unique.size,
    coverage: binding === currentBinding && captured ? 'receipt-only' : 'unknown',
    gap: 'unknown',
    replay: 'unproven',
  };
}

export function respCommand(parts) {
  requireUsage(
    Array.isArray(parts) &&
      parts.every((p) => typeof p === 'string' && Buffer.byteLength(p) <= 1024),
    'INPUT_LIMIT'
  );
  const [command, arg, count] = parts;
  const valid =
    command === 'AUTH'
      ? parts.length === 2 && arg.length > 0
      : ['PING', 'QUIT'].includes(command)
        ? parts.length === 1
        : ['SUBSCRIBE', 'UNSUBSCRIBE'].includes(command)
          ? parts.length === 2 && arg === 'usage'
          : ['LPOP', 'RPOP'].includes(command) &&
            arg === 'usage' &&
            (parts.length === 2 || (parts.length === 3 && /^(?:[1-9]|1[0-6])$/.test(count)));
  requireUsage(valid, 'INPUT_LIMIT');
  return Buffer.from(
    `*${parts.length}\r\n` + parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')
  );
}

// Bounded RESP2 parser: incomplete frames wait; malformed frames fail closed.
export function parseResp(buffer, offset = 0, depth = 0) {
  requireUsage(buffer.length <= MiB && depth <= 4, 'INPUT_LIMIT');
  const end = buffer.indexOf('\r\n', offset);
  if (end < 0) return null;
  const kind = String.fromCharCode(buffer[offset]);
  const text = buffer.toString('utf8', offset + 1, end);
  const cursor = end + 2;
  if (kind === '+' || kind === '-')
    return { value: kind === '-' ? { error: true } : text, end: cursor };
  requireUsage([':', '$', '*'].includes(kind) && /^-?\d+$/.test(text), 'INPUT_LIMIT');
  const size = Number(text);
  requireUsage(Number.isSafeInteger(size), 'INPUT_LIMIT');
  if (kind === ':') return { value: size, end: cursor };
  requireUsage(size >= -1 && size <= (kind === '*' ? 16 : MiB), 'INPUT_LIMIT');
  if (size === -1) return { value: null, end: cursor };
  if (kind === '$') {
    if (buffer.length < cursor + size + 2) return null;
    requireUsage(
      buffer.toString('ascii', cursor + size, cursor + size + 2) === '\r\n',
      'INPUT_LIMIT'
    );
    return { value: buffer.toString('utf8', cursor, cursor + size), end: cursor + size + 2 };
  }
  const value = [];
  let position = cursor;
  for (let i = 0; i < size; i++) {
    const item = parseResp(buffer, position, depth + 1);
    if (!item) return null;
    value.push(item.value);
    position = item.end;
  }
  return { value, end: position };
}

export async function openResp(f) {
  const socket = net.connect({ host: '127.0.0.1', port: f.config.server.port });
  let buffer = Buffer.alloc(0),
    frames = [],
    failure,
    total = 0,
    count = 0;
  const stop = () => socket.destroy();
  const closed = new Promise((resolve) => socket.once('close', resolve));
  f.signal?.addEventListener('abort', stop, { once: true });
  socket.on('error', () => {
    failure = fault('TARGET_UNREACHABLE');
  });
  socket.on('data', (chunk) => {
    try {
      total += chunk.length;
      requireUsage(total <= 32 * MiB && buffer.length + chunk.length <= MiB, 'INPUT_LIMIT');
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseResp(buffer);
        if (!parsed) break;
        requireUsage(++count <= 1100, 'INPUT_LIMIT');
        frames.push(parsed.value);
        buffer = buffer.subarray(parsed.end);
      }
    } catch (error) {
      failure = error;
      socket.destroy();
    }
  });
  const next = async () => {
    const deadline = performance.now() + 5000;
    while (!frames.length) {
      if (failure) throw failure;
      requireUsage(!socket.destroyed && !f.signal?.aborted, 'TARGET_UNREACHABLE');
      requireUsage(performance.now() < deadline, 'TIMEOUT');
      await wait(10, f.signal);
    }
    return frames.shift();
  };
  const actor = {
    get closed() {
      return socket.destroyed;
    },
    send: (parts) => socket.write(respCommand(parts)),
    next,
    async record() {
      for (let i = 0; i < 8; i++) {
        const frame = await next();
        requireUsage(Array.isArray(frame) && frame[0] === 'message' && frame[1] === 'usage');
        const record = JSON.parse(frame[2]);
        if (record.support_refresh === true || record.refresh === true) continue;
        return record;
      }
      throw fault('INPUT_LIMIT');
    },
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    async close() {
      socket.destroy();
      await closed;
      f.signal?.removeEventListener('abort', stop);
      buffer = Buffer.alloc(0);
      frames = [];
    },
  };
  try {
    actor.send(['AUTH', f.managementKey]);
    requireUsage((await next()) === 'OK');
    return actor;
  } catch (error) {
    await actor.close();
    throw error;
  }
}

export async function captureThenDrop(f, pop) {
  let captured,
    relayFailure,
    handled = false;
  const server = http.createServer(async (request, response) => {
    if (handled || request.method !== 'GET' || request.url !== '/receipt') {
      response.writeHead(404).end();
      return;
    }
    handled = true;
    try {
      captured = await pop();
    } catch (error) {
      relayFailure = error;
    }
    response.destroy(); // Only after the complete upstream response was captured.
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    let delivered = false;
    try {
      await f.loopbackRequest({ port: server.address().port, route: '/receipt', signal: f.signal });
      delivered = true;
    } catch (error) {
      requireUsage(error.code === 'TARGET_UNREACHABLE');
    }
    if (relayFailure) throw relayFailure;
    requireUsage(handled && Array.isArray(captured) && captured.length > 0 && !delivered);
    return captured;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function dispatchUsageStage(spec, f) {
  const group = spec.id.match(/^AQ04-U(\d{2})-/)?.[1];
  requireUsage(group);
  const number = Number(group),
    budget = usageBudget(number === 17),
    actors = [];
  let response,
    observation = false,
    state = false,
    control = false;
  const mgmt = async (method, name, body) => {
    response = await f.mgmt(method, CONFIG + name, body);
    requireUsage(response.status === 200);
    return response.json;
  };
  const stats = async (value) => {
    await mgmt('PUT', STATS, value);
    requireUsage((await mgmt('GET', STATS)) === value);
    await wait(350, f.signal); // bounded watcher settling, never a consuming retry
  };
  const valid = (record) =>
    record &&
    record.model === 'aq02-model' &&
    record.api_key === f.clientKey &&
    record.tokens?.total_tokens === 2 &&
    typeof record.execution_id === 'string' &&
    record.execution_id.length > 0;
  const ids = (records) => {
    requireUsage(records.every(valid));
    return records.map((r) => r.execution_id);
  };
  const pop = async (count = 1, useDefault = false) => {
    budget.pop(count);
    response = await f.mgmt('GET', QUEUE + (useDefault ? '' : `?count=${count}`));
    requireUsage(
      response.status === 200 && Array.isArray(response.json) && response.json.length <= count
    );
    budget.receive(response.json);
    ids(response.json);
    return response.json;
  };
  const produce = async (count) => {
    budget.produce(count);
    const before = f.stub.requests;
    for (let i = 0; i < count; i++) {
      const r = await f.data();
      requireUsage(r.status === 200 && r.json?.choices?.[0]?.message?.content === 'AQ02_OK');
    }
    requireUsage(f.stub.requests === before + count);
    await wait(250, f.signal);
  };
  const positive = async () => {
    await produce(1);
    const received = await pop();
    requireUsage(received.length === 1);
    return received;
  };
  const subscribe = async () => {
    const actor = await openResp(f);
    actors.push(actor);
    actor.send(['SUBSCRIBE', 'usage']);
    const ack = await actor.next();
    requireUsage(Array.isArray(ack) && ack[0] === 'subscribe' && ack[1] === 'usage');
    return actor;
  };
  try {
    if (number === 1) {
      observation = (await mgmt('GET', STATS)) === false;
      response = await f.mgmt('GET', CONFIG + RETENTION);
      state = response.status === 404; // omitted document leaf; effective default is not a GET fact
      control = (await f.mgmt('GET', '/config')).json?.server?.port === f.config.server.port;
    } else if (number === 8) {
      const values = [];
      for (const input of [0, -1, 3600, 3601]) {
        await mgmt('PUT', RETENTION, input);
        values.push(await mgmt('GET', RETENTION));
      }
      observation = values[0] === 0 && values[1] === -1;
      state = values[2] === 3600 && values[3] === 3601; // document readback, runtime clamp unobserved
      control = (await mgmt('GET', STATS)) === false;
    } else if ([10, 11, 18].includes(number)) {
      await stats(true);
      const received = await positive();
      const receiptIDs = ids(received),
        binding = Object.freeze({ generation: 1 });
      const projected = projectReceipts(
        [...receiptIDs, ...receiptIDs],
        binding,
        binding,
        number !== 10
      );
      observation = projected.received === 2 && projected.duplicates === 1;
      state = projected.gap === 'unknown' && projected.replay === 'unproven';
      control =
        projectReceipts(receiptIDs, binding, { generation: 1 }, true).coverage === 'unknown';
      if (number === 10) {
        // Deliberately discard before complete receipt: the cutpoint is unknown.
        await produce(1);
        budget.pop();
        const lost = await f.mgmt('GET', QUEUE + '?count=1', undefined, undefined, undefined, {
          loseResponse: true,
        });
        observation &&= lost.status === null && projected.coverage === 'unknown';
      }
    } else {
      await stats(true);
      const pre = await positive();
      control = pre.length === 1;
      if (number === 2) {
        observation = (await mgmt('GET', STATS)) === true;
        state = control;
      } else if (number === 3) {
        await produce(4);
        const first = await pop(1, true),
          rest = await pop(3);
        const received = [...first, ...rest];
        observation = first.length === 1 && rest.length === 3;
        state =
          new Set(ids(received)).size === 4 &&
          received.every((r, i) => i === 0 || r.timestamp >= received[i - 1].timestamp);
      } else if (number === 4) {
        await produce(2);
        await stats(false);
        const old = await pop(2);
        await produce(1);
        const empty = await pop();
        await stats(true);
        control &&= (await positive()).length === 1;
        observation = old.length === 2;
        state = empty.length === 0; // observed empty only, not a zero-usage claim
      } else if (number === 5) {
        await produce(2);
        const actor = await subscribe();
        await produce(1);
        requireUsage(valid(await actor.record()));
        const saved = structuredClone(f.config);
        response = await f.mgmt('PUT', '/config/management/secret-key', '');
        requireUsage(response.status === 200);
        await wait(500, f.signal);
        observation = (await f.mgmt('GET', '/config')).status === 404;
        await wait(100, f.signal);
        state = actor.closed;
        writeFileSync(f.filename, JSON.stringify(saved), { mode: 0o600 });
        await wait(750, f.signal);
        requireUsage((await f.mgmt('GET', '/config')).status === 200);
        await stats(true);
        state &&= (await pop(2)).length === 0;
        control &&= (await positive()).length === 1;
      } else if (number === 6 || number === 7) {
        const seconds = number === 6 ? 5 : 60;
        if (number === 6) {
          await mgmt('PUT', RETENTION, seconds);
          await wait(350, f.signal);
        }
        if (number === 6) requireUsage((await mgmt('GET', RETENTION)) === seconds);
        else requireUsage((await f.mgmt('GET', CONFIG + RETENTION)).status === 404);
        await produce(2);
        const within = await pop(); // proves a same-batch receipt, not a peek at the other record
        const started = performance.now();
        await wait(seconds * 1000 + 200, f.signal);
        const after = await pop(2);
        observation = within.length === 1 && performance.now() - started >= seconds * 1000;
        state = after.length === 0;
        control &&= (await positive()).length === 1;
      } else if (number === 9) {
        await produce(1);
        const captured = await captureThenDrop(f, pop);
        const after = await pop();
        observation = captured.length === 1;
        state = !ids(after).some((id) => ids(captured).includes(id));
      } else if (number === 12 || number === 13) {
        await produce(2);
        const oldPID = f.child.child.pid;
        await f.restart(number === 13);
        observation = f.child.child.pid !== oldPID;
        state = (await pop(2)).length === 0;
        control &&= (await positive()).length === 1;
      } else if (number === 14) {
        await produce(8);
        const [a, b] = await Promise.all([pop(4), pop(4)]);
        const aIDs = ids(a),
          bIDs = ids(b);
        observation = a.length + b.length === 8;
        state = !aIDs.some((id) => bIDs.includes(id));
      } else if (number === 15 || number === 16) {
        await produce(1); // existing backlog remains separate from subscriber traffic
        const a = await subscribe(),
          b = number === 16 ? await subscribe() : null;
        await produce(1);
        const ar = await a.record(),
          br = b ? await b.record() : null;
        requireUsage(valid(ar) && (!br || valid(br)));
        const backlog = await pop(2);
        observation = backlog.length === 1 && !ids(backlog).includes(ar.execution_id);
        state = !br || ar.execution_id === br.execution_id;
        a.send(['PING']);
        requireUsage((await a.next())?.[0] === 'pong');
        a.send(['UNSUBSCRIBE', 'usage']);
        requireUsage((await a.next())?.[0] === 'unsubscribe');
        await a.close();
        if (b) {
          b.send(['QUIT']);
          requireUsage((await b.next()) === 'OK');
          await b.close();
        }
        await wait(100, f.signal);
        await produce(1);
        const actor = await openResp(f);
        actors.push(actor);
        actor.send(['LPOP', 'usage', '1']);
        const raw = await actor.next();
        const received = Array.isArray(raw) ? raw.map((r) => JSON.parse(r)) : [JSON.parse(raw)];
        budget.pop();
        budget.receive(received);
        control &&= received.length === 1 && valid(received[0]);
        await produce(1);
        actor.send(['RPOP', 'usage']);
        const second = JSON.parse(await actor.next());
        budget.pop();
        budget.receive([second]);
        control &&= valid(second);
      } else if (number === 17) {
        const actor = await subscribe();
        actor.pause();
        // Bounded pressure is observed; an overflow cutpoint is not inferred.
        await produce(64);
        actor.resume();
        const received = [];
        for (let i = 0; i < 64; i++) received.push(await actor.record());
        budget.receive(received);
        observation = received.every(valid) && new Set(ids(received)).size === 64;
        state = projectReceipts(ids(received), actor, actor, true).gap === 'unknown';
      }
    }
    return { response, checks: [observation, state, control], limited: true };
  } finally {
    let failed = false;
    for (const actor of actors)
      try {
        await actor.close();
      } catch {
        failed = true;
      }
    requireUsage(!failed, 'CLEANUP_FAILED');
  }
}
