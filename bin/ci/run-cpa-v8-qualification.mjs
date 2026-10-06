#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const MiB = 1024 * 1024;
const HERE = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
const { createManagementManifest, validateEvidence } = await import(
  pathToFileURL(path.join(HERE, 'validate-cpa-v8-evidence.mjs')).href
);
const MANAGEMENT = '/v8/management';
const MODEL = 'aq02-model';
const NAME = 'aq02-synthetic.json';
const JSON_BYTES = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const freshKey = () => randomBytes(24).toString('hex');
const typedCodes = new Set([
  'SETUP_FAILED',
  'INPUT_LIMIT',
  'TIMEOUT',
  'CANCELLED',
  'TARGET_UNREACHABLE',
  'CLEANUP_FAILED',
]);
class Fault extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const insist = (ok, code = 'SETUP_FAILED') => {
  if (!ok) throw new Fault(code);
};
const safeCode = (error) => (typedCodes.has(error?.code) ? error.code : 'SETUP_FAILED');
const stamp = (s) => [s.dev, s.ino, s.size, s.mode, s.mtimeMs, s.ctimeMs, s.nlink];

export function readOwnedFile(
  filename,
  limit = MiB,
  owner = typeof process.getuid === 'function' ? process.getuid() : null
) {
  insist(path.isAbsolute(filename) && realpathSync(filename) === filename);
  const before = lstatSync(filename);
  insist(
    before.isFile() &&
      before.nlink === 1 &&
      !(before.mode & 0o022) &&
      (owner === null || before.uid === owner)
  );
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    insist(same(stamp(before), stamp(fstatSync(fd))));
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, Math.min(65536, bytes.length - count), null);
      if (!n) break;
      count += n;
    }
    insist(count <= limit, 'INPUT_LIMIT');
    insist(
      same(stamp(before), stamp(fstatSync(fd))) && same(stamp(before), stamp(lstatSync(filename)))
    );
    return bytes.subarray(0, count);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ownedDirectory(directory) {
  insist(path.isAbsolute(directory) && realpathSync(directory) === directory);
  const s = lstatSync(directory);
  insist(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      !(s.mode & 0o077) &&
      (typeof process.getuid !== 'function' || s.uid === process.getuid())
  );
}
const save = (filename, value) =>
  writeFileSync(filename, JSON_BYTES(value), { flag: 'wx', mode: 0o600 });

export function childEnvironment(home, managementSecret) {
  const env = { HOME: home, TMPDIR: home, LANG: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' };
  if (managementSecret) env.MANAGEMENT_PASSWORD = managementSecret;
  return env;
}

export function boundedRequest({
  port,
  method = 'GET',
  route,
  headers = {},
  body,
  signal,
  timeoutMs = 5000,
  loseResponse = false,
}) {
  insist(
    Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      route.startsWith('/') &&
      !route.startsWith('//') &&
      !/[\r\n]/.test(route)
  );
  const bytes =
    body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(JSON.stringify(body));
  insist(bytes.length <= MiB && timeoutMs > 0 && timeoutMs <= 5000, 'INPUT_LIMIT');
  return new Promise((resolve, reject) => {
    let done = false,
      timer;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) {
        request.destroy();
        reject(error);
      } else resolve(result);
    };
    const cancel = () => finish(new Fault('CANCELLED'));
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: route,
        agent: false,
        maxHeaderSize: 32768,
        headers: {
          'accept-encoding': 'identity',
          'content-type': 'application/json',
          'content-length': bytes.length,
          ...headers,
        },
      },
      (response) => {
        if (loseResponse) {
          response.destroy();
          return finish(null, { status: null, requestBytes: bytes.length, responseBytes: 0 });
        }
        if (
          response.headers['content-encoding'] &&
          response.headers['content-encoding'] !== 'identity'
        )
          return finish(new Fault('INPUT_LIMIT'));
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MiB) finish(new Fault('INPUT_LIMIT'));
          else chunks.push(chunk);
        });
        response.on('error', () => finish(new Fault('TARGET_UNREACHABLE')));
        response.on('aborted', () => finish(new Fault('TARGET_UNREACHABLE')));
        response.on('end', () => {
          if (!response.complete) return finish(new Fault('TARGET_UNREACHABLE'));
          const raw = Buffer.concat(chunks);
          let json;
          try {
            json = JSON.parse(raw.toString('utf8'));
          } catch {
            /* YAML is inspected privately. */
          }
          finish(null, {
            status: response.statusCode,
            json,
            raw,
            requestBytes: bytes.length,
            responseBytes: size,
          });
        });
      }
    );
    request.on('error', (error) =>
      finish(new Fault(error.code === 'HPE_HEADER_OVERFLOW' ? 'INPUT_LIMIT' : 'TARGET_UNREACHABLE'))
    );
    timer = setTimeout(() => finish(new Fault('TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    if (!done) request.end(bytes);
  });
}

export function spawnOwned(
  executable,
  args,
  { cwd, env, signal, outputLimit = MiB, capture = false }
) {
  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false,
    fault = null,
    size = 0,
    forced = false,
    stopped = false,
    forceTimer;
  const chunks = [];
  const groupAlive = () => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (e) {
      return e.code !== 'ESRCH';
    }
  };
  const kill = (sig) => {
    if (!child.pid || (sig === 'SIGKILL' && forced)) return;
    if (sig === 'SIGKILL') forced = true;
    try {
      process.kill(-child.pid, sig);
    } catch (e) {
      if (e.code !== 'ESRCH') fault ??= 'CLEANUP_FAILED';
    }
  };
  const abort = () => {
    fault ??= 'CANCELLED';
    kill('SIGTERM');
    forceTimer ??= setTimeout(() => kill('SIGKILL'), 5000);
  };
  const closed = new Promise((resolve) => {
    child.once('error', () => {
      fault = 'SETUP_FAILED';
    });
    child.once('close', (code) => {
      exited = true;
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      resolve(code);
    });
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      size += bytes.length;
      if (size > outputLimit) {
        fault = 'INPUT_LIMIT';
        kill('SIGKILL');
      } else if (capture && stream === child.stdout) chunks.push(bytes);
    });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    child,
    closed,
    get fault() {
      return fault;
    },
    get alive() {
      return !exited && !fault;
    },
    output: () => Buffer.concat(chunks),
    async stop() {
      if (stopped) return;
      kill('SIGTERM');
      const graceful = performance.now() + 5000;
      while ((!exited || groupAlive()) && performance.now() < graceful) await delay(25);
      if (!exited || groupAlive()) {
        kill('SIGKILL');
        const forcedDeadline = performance.now() + 1000;
        while ((!exited || groupAlive()) && performance.now() < forcedDeadline) await delay(25);
      }
      insist(exited && !groupAlive(), 'CLEANUP_FAILED');
      stopped = true;
    },
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const end = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(end, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Fault('CANCELLED'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function startStub(key) {
  let requests = 0,
    rejected = 0,
    fail = false;
  const server = http.createServer({ maxHeaderSize: 32768 }, (request, response) => {
    let size = 0;
    const chunks = [];
    request.on('error', () => {});
    request.on('data', (b) => {
      size += b.length;
      if (size > MiB) request.destroy();
      else chunks.push(b);
    });
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks));
      } catch {
        /* denied below */
      }
      if (
        request.url !== '/v1/chat/completions' ||
        request.method !== 'POST' ||
        request.headers.authorization !== `Bearer ${key}` ||
        body?.model !== MODEL ||
        body?.stream === true ||
        body?.messages?.at(-1)?.content !== 'AQ02 synthetic request'
      ) {
        rejected++;
        response.writeHead(400);
        response.end('{}');
        return;
      }
      requests++;
      response.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          fail
            ? { error: { message: 'synthetic provider failure', type: 'server_error' } }
            : {
                id: 'aq02-synthetic',
                object: 'chat.completion',
                created: 1,
                model: MODEL,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'AQ02_OK' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }
        )
      );
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    get requests() {
      return requests;
    },
    get rejected() {
      return rejected;
    },
    fail(value) {
      fail = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForListener(port, child, signal) {
  // TCP only schedules the semantic probe; it never establishes readiness.
  for (;;) {
    insist(child.alive, child.fault ?? 'SETUP_FAILED');
    const listening = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const finish = (ready, error) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(ready);
      };
      const abort = () => finish(false, new Fault('CANCELLED'));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(1000, () => finish(false));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    if (listening) return;
    await delay(100, signal);
  }
}

export function fixtureConfig({ port, stubPort, authDir, managementKey, clientKey, upstreamKey }) {
  return {
    'config-version': 8,
    server: { host: '127.0.0.1', port, 'trusted-proxies': [], discovery: { enabled: false } },
    management: {
      'allow-remote': false,
      'secret-key': managementKey,
      'disable-control-panel': true,
      'disable-auto-update-panel': true,
    },
    access: { 'api-keys': [clientKey] },
    routing: { retry: { 'request-retry': 0, 'max-retry-interval': 0 }, 'session-affinity': false },
    'api-keys': {
      'openai-compatibility': [
        {
          name: 'aq02-stub',
          'base-url': `http://127.0.0.1:${stubPort}/v1`,
          'request-retry': 0,
          keys: [{ 'api-key': upstreamKey }],
          models: [{ name: MODEL, alias: MODEL }],
        },
      ],
    },
    oauth: {
      'auth-dir': authDir,
      providers: {
        codex: {
          'live-media-relay': {
            'ice-servers': [
              { urls: ['turn:127.0.0.1:3478'], username: freshKey(), credential: freshKey() },
            ],
          },
        },
      },
    },
    plugins: { enabled: false },
    home: { enabled: false },
    observability: {
      usage: { 'usage-statistics-enabled': false },
      pprof: { enable: false },
      logs: { debug: false, 'logging-to-file': false, 'request-log': false },
    },
  };
}

// The Docker inspect document is a host-created, read-only execution input.
// It is cross-checked here; independent acceptance still inspects it on the host.
export function checkIsolation(inspect, runtime) {
  const host = inspect?.HostConfig;
  insist(
    runtime.platform === 'linux' &&
      runtime.arch === 'x64' &&
      runtime.uid > 0 &&
      runtime.nodeMajor === 24 &&
      runtime.libc &&
      runtime.onlyLoopback &&
      runtime.readonlyRoot &&
      runtime.noNewPrivileges &&
      runtime.noCapabilities
  );
  insist(
    /^sha256:[a-f0-9]{64}$/.test(inspect?.Image ?? '') &&
      /^[a-f0-9]{64}$/.test(inspect?.Id ?? '') &&
      host?.NetworkMode === 'none' &&
      host.ReadonlyRootfs === true &&
      host.CapDrop?.includes('ALL') &&
      host.SecurityOpt?.some((v) => v === 'no-new-privileges' || v === 'no-new-privileges:true') &&
      host.Memory > 0 &&
      host.Memory <= 2 * 1024 * MiB &&
      host.PidsLimit > 0 &&
      host.PidsLimit <= 128 &&
      host.NanoCpus > 0 &&
      host.NanoCpus <= 2e9 &&
      !host.Privileged &&
      !host.PidMode &&
      !host.IpcMode?.startsWith('host') &&
      Object.keys(host.PortBindings ?? {}).length === 0 &&
      inspect.Config?.User === String(runtime.uid)
  );
  const mounts = inspect.Mounts ?? [];
  const expected = [
    '/input/' + createManagementManifest().candidate.assetName,
    '/run/aq02-isolation.json',
    '/run/aq02-manifest.json',
    '/work',
  ];
  insist(
    mounts.length === 4 &&
      new Set(mounts.map((m) => m.Destination)).size === 4 &&
      mounts.every(
        (m) =>
          m.Type === 'bind' &&
          m.RW === (m.Destination === '/work') &&
          expected.includes(m.Destination)
      )
  );
  insist(Object.keys(host.Tmpfs ?? {}).length === 0);
  return { containerId: inspect.Id, imageDigest: inspect.Image };
}

function runtimeIsolation() {
  const status = readFileSync('/proc/self/status', 'utf8');
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
  const interfaces = Object.values(networkInterfaces()).flat();
  return {
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid(),
    nodeMajor: +process.versions.node.split('.')[0],
    libc: process.report.getReport().header.glibcVersionRuntime,
    onlyLoopback: interfaces.length > 0 && interfaces.every((i) => i.internal),
    readonlyRoot: mounts.some((line) => {
      const p = line.split(' ');
      return p[4] === '/' && p[5]?.split(',').includes('ro');
    }),
    noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status),
    noCapabilities: /^CapEff:\s+0+$/m.test(status),
  };
}

export async function openFixture(work, spec, binary, binaryHash, signal) {
  const root = mkdtempSync(path.join(work, 'case-'));
  const home = path.join(root, 'home'),
    authDir = path.join(root, 'auth');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(authDir, { mode: 0o700 });
  const managementKey = freshKey(),
    clientKey = freshKey(),
    upstreamKey = freshKey();
  let stub, child;
  const clean = async () => {
    let failed = false;
    if (child)
      try {
        await child.stop();
      } catch {
        failed = true;
      }
    if (stub)
      try {
        await stub.close();
      } catch {
        failed = true;
      }
    if (!failed)
      try {
        rmSync(root, { recursive: true });
        insist(!readdirSync(work).includes(path.basename(root)));
      } catch {
        failed = true;
      }
    insist(!failed, 'CLEANUP_FAILED');
  };
  try {
    stub = await startStub(upstreamKey);
    const port = await unusedPort();
    const config = fixtureConfig({
      port,
      stubPort: stub.port,
      authDir,
      managementKey,
      clientKey,
      upstreamKey,
    });
    const noSecret = spec.id === 'AQ02-M06-no-secret';
    const envSecret = spec.id === 'AQ02-M06-env-secret';
    if (noSecret || envSecret) config.management['secret-key'] = '';
    if (spec.id.startsWith('AQ02-M09-')) {
      const variant = spec.id.slice('AQ02-M09-'.length);
      if (variant === 'absent') delete config.access['api-keys'];
      else config.access['api-keys'] = variant === 'null' ? null : [];
    }
    const filename = path.join(root, 'config.yaml');
    save(filename, config); // JSON is valid YAML.
    insist(hash(readOwnedFile(binary, 128 * MiB)) === binaryHash);
    const env = childEnvironment(home, envSecret ? managementKey : undefined);
    child = spawnOwned(binary, ['--config', filename, '--local-model'], { cwd: root, env, signal });
    const request = (method, route, body, key = managementKey, extra = {}, options = {}) => {
      insist(child.alive, child.fault ?? 'TARGET_UNREACHABLE');
      return boundedRequest({
        port,
        method,
        route,
        body,
        signal,
        headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...extra },
        ...options,
      });
    };
    const mgmt = (method, route, body, key, extra, options) =>
      request(method, MANAGEMENT + route, body, key, extra, options);
    const data = (key = clientKey, model = MODEL, options = {}) =>
      request(
        'POST',
        '/v1/chat/completions',
        { model, stream: false, messages: [{ role: 'user', content: 'AQ02 synthetic request' }] },
        key,
        {},
        options
      );
    const startup = new AbortController();
    const startupTimer = setTimeout(() => startup.abort(), 30000);
    const startupSignal = signal ? AbortSignal.any([signal, startup.signal]) : startup.signal;
    try {
      await waitForListener(port, child, startupSignal);
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          r = await mgmt('GET', '/config', undefined, undefined, undefined, {
            signal: startupSignal,
          });
          break;
        } catch (error) {
          if (attempt !== 0 || error.code !== 'TARGET_UNREACHABLE') throw error;
          await delay(100, startupSignal);
        }
      }
      if (noSecret) {
        insist(r.status === 404);
        const count = stub.requests;
        insist(
          (await data(clientKey, MODEL, { signal: startupSignal })).json?.choices?.[0]?.message
            ?.content === 'AQ02_OK' && stub.requests === count + 1
        );
      } else
        // A reachable service with the wrong identity is never adopted as ours.
        insist(
          r.status === 200 &&
            r.json?.['config-version'] === 8 &&
            r.json?.server?.port === port &&
            r.json?.oauth?.['auth-dir'] === authDir &&
            same(r.json?.access?.['api-keys'], config.access['api-keys'])
        );
    } catch (error) {
      if (startup.signal.aborted && !signal?.aborted) throw new Fault('TIMEOUT');
      throw error;
    } finally {
      clearTimeout(startupTimer);
    }
    return {
      root,
      home,
      authDir,
      filename,
      config,
      managementKey,
      clientKey,
      upstreamKey,
      stub,
      child,
      request,
      mgmt,
      data,
      clean,
      signal,
    };
  } catch (error) {
    await clean();
    throw error;
  }
}

const successfulData = (r) =>
  r.status === 200 && r.json?.choices?.[0]?.message?.content === 'AQ02_OK';
const denial = (r, statuses = [400, 401, 403, 404, 409, 422, 500]) =>
  statuses.includes(r.status) &&
  (typeof r.json?.error === 'string' || typeof r.json?.error === 'object');
const sourceBytes = (f) => readOwnedFile(f.filename);
const noCredential = (f) => readdirSync(f.authDir).every((name) => !name.endsWith('.json'));
const credential = () => ({
  type: 'aq02-synthetic',
  access_token: freshKey(),
  email: 'fixture@example.invalid',
  weight: 1,
});
const upload = (f, value = credential()) => f.mgmt('POST', '/credentials?name=' + NAME, value);
const listedCredential = async (f) =>
  (await f.mgmt('GET', '/credentials?name=' + NAME)).json?.files?.find((v) => v.name === NAME);
const persistedCredential = (f) => JSON.parse(readOwnedFile(path.join(f.authDir, NAME)));
const getConfig = async (f) => (await f.mgmt('GET', '/config')).json;
const goodManagement = (r, f) =>
  r.status === 200 &&
  r.json?.['config-version'] === 8 &&
  r.json?.server?.port === f.config.server.port;

async function poll(check, signal, milliseconds = 5000) {
  const deadline = performance.now() + milliseconds;
  do {
    if (await check()) return true;
    await delay(150, signal);
  } while (performance.now() < deadline);
  return false;
}

function multipart(entries) {
  const boundary = 'AQ02Boundary';
  const chunks = entries.map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n`
  );
  return {
    body: Buffer.from(chunks.join('') + `--${boundary}--\r\n`),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function beginOAuth(f) {
  const r = await f.mgmt('GET', '/oauth/auth-url?provider=codex');
  insist(
    r.status === 200 &&
      r.json?.status === 'ok' &&
      typeof r.json?.state === 'string' &&
      /^[A-Za-z0-9_-]+$/.test(r.json.state)
  );
  const url = new URL(r.json.url);
  insist(
    url.protocol === 'https:' &&
      url.hostname === 'auth.openai.com' &&
      url.searchParams.get('state') === r.json.state
  );
  return { response: r, state: r.json.state };
}
const oauthStatus = (f, state) => f.mgmt('GET', '/oauth/status?state=' + encodeURIComponent(state));
const unknownOAuth = (r) =>
  r.status === 200 && r.json?.status === 'error' && r.json?.error === 'unknown or expired state';
const callback = (f, state, extra = {}, method = 'POST') => {
  const body = { provider: 'codex', state, error: 'AQ02 synthetic denial', ...extra };
  return method === 'POST'
    ? f.mgmt('POST', '/oauth/callback', body, null)
    : f.mgmt('GET', '/oauth/callback?' + new URLSearchParams(body), undefined, null);
};

// Each branch below is a fixed recipe. Booleans represent separate response,
// persisted/runtime postcondition and positive-control observations.
export async function dispatchManagement(spec, f) {
  const [, group, variant] = /^AQ02-M(\d\d)-(.+)$/.exec(spec.id) ?? [];
  insist(group && spec.id !== 'AQ02-M25-real-refresh' && spec.id !== 'AQ02-M33-real-exchange');
  let r,
    stateOK = false,
    controlOK = false,
    httpOK = false,
    limited = false;
  const before = sourceBytes(f);
  const control = async () => {
    const count = f.stub.requests;
    const result = await f.data();
    return successfulData(result) && f.stub.requests === count + 1;
  };
  const unchanged = () => before.equals(sourceBytes(f));
  const respond = (response, expected) => {
    r = response;
    httpOK = expected;
  };
  switch (+group) {
    case 1:
    case 2: {
      r =
        +group === 1
          ? await f.mgmt('GET', '/config')
          : await f.mgmt(
              'GET',
              '/config',
              undefined,
              variant === 'header' ? null : f.managementKey,
              { 'X-Management-Key': variant === 'header' ? f.managementKey : f.clientKey }
            );
      httpOK = goodManagement(r, f);
      stateOK = unchanged();
      controlOK = await control();
      break;
    }
    case 3: {
      controlOK = goodManagement(await f.mgmt('GET', '/config'), f);
      r = await f.mgmt('GET', '/config', undefined, variant === 'missing' ? null : freshKey());
      httpOK = denial(r, [401]);
      stateOK = unchanged();
      limited = true;
      break;
    }
    case 4: {
      controlOK = goodManagement(await f.mgmt('GET', '/config'), f);
      const rejected = [];
      for (let i = 0; i < 5; i++)
        rejected.push(await f.mgmt('GET', '/config', undefined, freshKey()));
      r = await f.mgmt('GET', '/config');
      httpOK = rejected.every((v) => denial(v, [401])) && denial(r, [403]);
      stateOK = unchanged();
      limited = true;
      break;
    }
    case 5: {
      controlOK = (await control()) && goodManagement(await f.mgmt('GET', '/config'), f);
      const count = f.stub.requests;
      const targetManagement = variant.endsWith('as-management');
      const key = variant.startsWith('client')
        ? f.clientKey
        : variant.startsWith('management')
          ? f.managementKey
          : f.upstreamKey;
      r = targetManagement ? await f.mgmt('GET', '/config', undefined, key) : await f.data(key);
      httpOK = denial(r, [401]);
      stateOK = unchanged() && f.stub.requests === count;
      limited = true;
      break;
    }
    case 6: {
      r = await f.mgmt('GET', '/config');
      httpOK = variant === 'no-secret' ? r.status === 404 : goodManagement(r, f);
      stateOK = unchanged();
      controlOK = await control();
      limited = true;
      break;
    }
    case 7: {
      const count = f.stub.requests;
      r = await f.data();
      httpOK = successfulData(r);
      stateOK = f.stub.requests === count + 1;
      controlOK = goodManagement(await f.mgmt('GET', '/config'), f);
      break;
    }
    case 8: {
      controlOK = await control();
      const count = f.stub.requests;
      if (variant === 'provider-error') f.stub.fail(true);
      r = await f.data(
        variant === 'missing' ? null : variant === 'wrong' ? freshKey() : f.clientKey
      );
      httpOK = variant === 'provider-error' ? r.status >= 500 : denial(r, [401]);
      stateOK = f.stub.requests === count + (variant === 'provider-error' ? 1 : 0);
      limited = true;
      break;
    }
    case 9: {
      const count = f.stub.requests;
      r = await f.data(null);
      httpOK = successfulData(r);
      stateOK = f.stub.requests === count + 1 && unchanged();
      controlOK = await control();
      limited = true;
      break;
    }
    case 10:
    case 19: {
      controlOK = await control();
      const replacement = freshKey();
      const method = +group === 19 ? variant.toUpperCase() : 'PUT';
      // DELETE clears the family: observe unauthenticated access explicitly.
      r = await f.mgmt(
        method,
        '/config/access/api-keys',
        method === 'DELETE' ? undefined : [replacement]
      );
      httpOK = r.status === 200 && r.json?.status === 'ok';
      const keys = await f.mgmt('GET', '/config/access/api-keys');
      const effective = await poll(async () => {
        const count = f.stub.requests;
        const next = await f.data(method === 'DELETE' ? null : replacement);
        return successfulData(next) && f.stub.requests === count + 1;
      }, f.signal);
      const old = method === 'DELETE' ? null : await f.data(f.clientKey);
      stateOK =
        effective &&
        (method === 'DELETE'
          ? keys.status === 404
          : same(keys.json, [replacement]) && denial(old, [401]));
      limited = method === 'DELETE';
      break;
    }
    case 11:
    case 12: {
      r = await f.mgmt(
        'GET',
        +group === 12 || variant === 'root'
          ? '/config'
          : variant === 'subtree'
            ? '/config/access/api-keys'
            : '/config.yaml'
      );
      // NormalizeConfigLayout returns a v8 YAML view without changing the file.
      // Match the fixed private fixture fields; byte equality is not its contract.
      httpOK =
        r.status === 200 &&
        (variant === 'yaml'
          ? /["']?config-version["']?\s*:\s*8(?:[,}\s]|$)/.test(r.raw.toString('utf8')) &&
            r.raw.includes(Buffer.from(f.clientKey)) &&
            r.raw.includes(Buffer.from(f.authDir)) &&
            goodManagement(await f.mgmt('GET', '/config'), f)
          : variant === 'subtree'
            ? same(r.json, [f.clientKey])
            : goodManagement(r, f));
      stateOK = unchanged();
      controlOK = await control();
      break;
    }
    case 13:
    case 14:
    case 17: {
      controlOK = await control();
      const replacement = freshKey();
      const config = await getConfig(f);
      config.access['api-keys'] = [replacement];
      if (+group === 14 && variant === 'map-patch') {
        r = await f.mgmt('PATCH', '/config', { access: { 'api-keys': [replacement] } });
      } else if (+group === 14) {
        r = await f.mgmt(variant === 'list-patch' ? 'PATCH' : 'PUT', '/config/access/api-keys', [
          replacement,
        ]);
      } else {
        const lose = variant === 'response-loss';
        r = await f.mgmt(
          'PUT',
          +group === 17 ? '/config.yaml' : '/config',
          config,
          undefined,
          +group === 17 ? { 'content-type': 'application/yaml' } : {},
          { loseResponse: lose }
        );
      }
      httpOK =
        variant === 'response-loss'
          ? r.status === null
          : r.status === 200 && r.json?.status === 'ok';
      const readback = await getConfig(f);
      const ice = f.config.oauth.providers.codex['live-media-relay']['ice-servers'][0];
      const persisted = sourceBytes(f);
      stateOK =
        same(readback?.access?.['api-keys'], [replacement]) &&
        readback?.server?.port === f.config.server.port &&
        readback?.oauth?.['auth-dir'] === f.authDir &&
        persisted.includes(Buffer.from(ice.username)) === (+group !== 17) &&
        persisted.includes(Buffer.from(ice.credential)) === (+group !== 17) &&
        !unchanged() &&
        (await poll(async () => successfulData(await f.data(replacement)), f.signal)) &&
        denial(await f.data(), [401]);
      limited = variant === 'response-loss';
      break;
    }
    case 15: {
      controlOK = await control();
      const input = { null: null, empty: [], false: false, zero: 0, 'invalid-type': [] }[variant];
      const leaf =
        variant === 'zero'
          ? 'routing/retry/request-retry'
          : variant === 'false'
            ? 'routing/session-affinity'
            : variant === 'invalid-type'
              ? 'server/port'
              : 'access/api-keys';
      if (variant === 'absent') r = await f.mgmt('GET', '/config/aq02-absent');
      else
        r = await f.mgmt(
          variant === 'delete' ? 'DELETE' : 'PUT',
          '/config/' + leaf,
          variant === 'delete' ? undefined : input
        );
      httpOK =
        variant === 'absent'
          ? denial(r, [404])
          : variant === 'invalid-type'
            ? denial(r, [400, 422])
            : r.status === 200;
      if (['absent', 'invalid-type'].includes(variant)) stateOK = unchanged();
      else {
        const readback = await f.mgmt('GET', '/config/' + leaf);
        stateOK = variant === 'delete' ? readback.status === 404 : same(readback.json, input);
        if (['delete', 'null', 'empty'].includes(variant))
          stateOK &&= await poll(async () => successfulData(await f.data(null)), f.signal);
        else stateOK &&= await control();
      }
      limited = true;
      break;
    }
    case 16: {
      controlOK = await control();
      const routes = {
        readonly: '/config/plugins/auth-revision',
        'invalid-path': '/config/access/api-keys/0',
        'invalid-body': '/config',
      };
      r = await f.mgmt('PUT', routes[variant], variant === 'invalid-body' ? Buffer.from('{') : 1);
      httpOK = denial(r, [400]);
      stateOK = unchanged();
      limited = true;
      break;
    }
    case 18: {
      controlOK = await control();
      if (variant === 'empty')
        insist((await f.mgmt('PUT', '/config/access/api-keys', [])).status === 200);
      const beforeRead = sourceBytes(f);
      r = await f.mgmt('GET', '/config/access/api-keys');
      httpOK = r.status === 200 && same(r.json, variant === 'empty' ? [] : [f.clientKey]);
      stateOK = beforeRead.equals(sourceBytes(f));
      limited = variant === 'empty';
      break;
    }
    case 20: {
      controlOK = await control();
      const replacement = freshKey();
      if (variant === 'write-failure') {
        // Linux prlimit targets only this recorded child. chmod is insufficient:
        // CPA deliberately restores owner-write permission before persisting.
        const limiter = spawnOwned(
          '/usr/bin/python3',
          [
            '-I',
            '-B',
            '-c',
            'import resource,sys; resource.prlimit(int(sys.argv[1]),resource.RLIMIT_FSIZE,(0,0))',
            String(f.child.child.pid),
          ],
          { cwd: f.root, env: childEnvironment(f.home), signal: f.signal, outputLimit: 4096 }
        );
        try {
          insist((await limiter.closed) === 0);
        } finally {
          await limiter.stop();
        }
      }
      r = await f.mgmt(
        'PUT',
        '/config/access/api-keys',
        variant === 'invalid'
          ? { key: 1 }
          : variant === 'duplicate'
            ? [f.clientKey, f.clientKey]
            : [replacement],
        undefined,
        {},
        { loseResponse: variant === 'response-loss' }
      );
      httpOK =
        variant === 'invalid'
          ? denial(r, [400, 422])
          : variant === 'write-failure'
            ? denial(r, [500])
            : variant === 'response-loss'
              ? r.status === null
              : r.status === 200;
      stateOK =
        variant === 'invalid'
          ? unchanged() && (await control())
          : variant === 'write-failure'
            ? // A write failure can truncate persisted config. It must not silently
              // activate the replacement key. Keep this destructive fixture private.
              denial(await f.data(replacement), [401]) && (await control())
            : same(
                (await f.mgmt('GET', '/config/access/api-keys')).json,
                variant === 'duplicate' ? [f.clientKey, f.clientKey] : [replacement]
              ) &&
              (await poll(
                async () =>
                  successfulData(await f.data(variant === 'duplicate' ? f.clientKey : replacement)),
                f.signal
              ));
      limited = true;
      break;
    }
    case 21: {
      if (variant === 'populated') insist((await upload(f)).status === 200);
      r = await f.mgmt(
        'GET',
        '/credentials?name=' +
          (variant === 'empty' ? 'aq02-absent.json' : NAME) +
          '&page=1&page_size=10'
      );
      httpOK =
        r.status === 200 && Array.isArray(r.json?.files) && typeof r.json?.observed_at === 'string';
      stateOK =
        variant === 'empty'
          ? r.json?.files?.length === 0
          : r.json?.files?.some((v) => v.name === NAME && typeof v.auth_index === 'string');
      controlOK = unchanged() && (await control());
      limited = true;
      break;
    }
    case 22: {
      const value = credential();
      controlOK = await control();
      if (variant === 'duplicate')
        insist((await upload(f, { ...value, weight: 2 })).status === 200);
      if (['multipart', 'partial'].includes(variant)) {
        const entries = [[NAME, value]];
        if (variant === 'partial') entries.push(['invalid.txt', {}]);
        const form = multipart(entries);
        r = await f.mgmt('POST', '/credentials', form.body, undefined, form.headers);
      } else r = await upload(f, variant === 'invalid' ? Buffer.from('{') : value);
      httpOK =
        variant === 'invalid'
          ? denial(r, [500])
          : variant === 'partial'
            ? r.status === 207 && r.json?.status === 'partial'
            : r.status === 200;
      stateOK =
        variant === 'invalid'
          ? noCredential(f) && !(await listedCredential(f))
          : Object.entries(value).every(
              ([key, expected]) => persistedCredential(f)[key] === expected
            ) && !!(await listedCredential(f));
      limited = true;
      break;
    }
    case 23: {
      insist((await upload(f)).status === 200);
      const saved = readOwnedFile(path.join(f.authDir, NAME));
      controlOK = !!(await listedCredential(f));
      const name =
        variant === 'unsafe' ? '../escape.json' : variant === 'missing' ? 'missing.json' : NAME;
      r = await f.mgmt('DELETE', '/credentials?name=' + encodeURIComponent(name));
      httpOK =
        variant === 'delete' ? r.status === 200 : denial(r, variant === 'missing' ? [404] : [400]);
      stateOK =
        variant === 'delete'
          ? noCredential(f) && !(await listedCredential(f))
          : readOwnedFile(path.join(f.authDir, NAME)).equals(saved) &&
            !!(await listedCredential(f));
      limited = true;
      break;
    }
    case 24: {
      insist((await upload(f)).status === 200);
      controlOK = !!(await listedCredential(f));
      const original = readOwnedFile(path.join(f.authDir, NAME));
      const body =
        variant === 'status'
          ? { name: NAME, disabled: true }
          : variant === 'fields'
            ? { name: NAME, weight: 2 }
            : variant === 'invalid'
              ? { name: NAME, weight: 'bad' }
              : variant === 'conflict'
                ? { name: NAME, weight: 1, ' weight ': 2 }
                : { name: NAME, type: 'aq02-changed' };
      r = await f.mgmt(
        'PATCH',
        variant === 'status' ? '/credentials/status' : '/credentials/fields',
        body
      );
      httpOK = ['invalid', 'conflict'].includes(variant) ? denial(r, [400]) : r.status === 200;
      const persisted = persistedCredential(f),
        runtime = await listedCredential(f);
      stateOK = ['invalid', 'conflict'].includes(variant)
        ? original.equals(readOwnedFile(path.join(f.authDir, NAME)))
        : variant === 'status'
          ? persisted.disabled === true && runtime?.disabled === true
          : variant === 'fields'
            ? persisted.weight === 2 && runtime?.weight === 2
            : persisted.type === 'aq02-changed' && !!runtime;
      // Fields API is not a read-only identity contract: type mutation is observed.
      limited = true;
      break;
    }
    case 25: {
      controlOK = await control();
      if (variant === 'refresh-error') {
        insist((await upload(f)).status === 200);
        controlOK &&= !!(await listedCredential(f));
      }
      const original =
        variant === 'refresh-error' ? readOwnedFile(path.join(f.authDir, NAME)) : null;
      // Existing name plus a mismatched auth_index is an offline identity error.
      // Real provider exchange/refresh has a separate required, unselected leaf.
      r = await f.mgmt(
        'POST',
        '/credentials/refresh',
        variant === 'invalid'
          ? Buffer.from('{')
          : {
              name: variant === 'missing' ? 'missing.json' : NAME,
              ...(variant === 'refresh-error' ? { auth_index: freshKey() } : {}),
            }
      );
      httpOK = denial(r, variant === 'invalid' ? [400] : [404]);
      stateOK = original
        ? original.equals(readOwnedFile(path.join(f.authDir, NAME)))
        : noCredential(f);
      limited = true;
      break;
    }
    case 26: {
      controlOK = await control();
      if (variant === 'start') {
        const flow = await beginOAuth(f);
        r = flow.response;
        httpOK = r.status === 200;
        stateOK = (await oauthStatus(f, flow.state)).json?.status === 'wait' && noCredential(f);
      } else {
        r = await f.mgmt(
          'GET',
          '/oauth/auth-url' + (variant === 'unknown-provider' ? '?provider=aq02-unknown' : '')
        );
        httpOK = denial(r, variant === 'unknown-provider' ? [404] : [400]);
        stateOK = noCredential(f);
      }
      limited = true;
      break;
    }
    case 27: {
      const flow = await beginOAuth(f);
      controlOK = (await oauthStatus(f, flow.state)).json?.status === 'wait';
      r =
        variant === 'auth'
          ? await f.mgmt('GET', '/oauth/status?state=' + flow.state, undefined, null)
          : await oauthStatus(f, variant === 'unknown' ? freshKey() : flow.state);
      httpOK =
        variant === 'auth'
          ? denial(r, [401])
          : variant === 'unknown'
            ? unknownOAuth(r)
            : r.status === 200 && r.json?.status === 'wait';
      stateOK = noCredential(f);
      limited = true;
      break;
    }
    case 28: {
      const flow = await beginOAuth(f);
      controlOK = (await oauthStatus(f, flow.state)).json?.status === 'wait';
      const state = variant.endsWith('missing')
        ? ''
        : variant === 'invalid'
          ? '../unsafe'
          : variant === 'unknown'
            ? freshKey()
            : flow.state;
      r = await callback(
        f,
        state,
        variant === 'mismatch' ? { provider: 'claude' } : {},
        variant.startsWith('get') ? 'GET' : 'POST'
      );
      httpOK = denial(r, variant === 'unknown' ? [404] : [400]);
      stateOK = noCredential(f) && (await oauthStatus(f, flow.state)).json?.status === 'wait';
      limited = true;
      break;
    }
    case 29:
    case 31: {
      const flow = await beginOAuth(f);
      controlOK = (await oauthStatus(f, flow.state)).json?.status === 'wait';
      if (variant === 'race') {
        const outcomes = await Promise.all([
          callback(f, flow.state),
          f.mgmt('DELETE', '/oauth/session?state=' + flow.state),
        ]);
        r = outcomes[0];
        httpOK = [200, 404, 409].includes(r.status) && outcomes[1].status === 200;
        stateOK =
          (await poll(async () => unknownOAuth(await oauthStatus(f, flow.state)), f.signal)) &&
          noCredential(f);
      } else {
        r = await callback(f, flow.state);
        httpOK = r.status === 200 && r.json?.status === 'ok';
        if (variant === 'repeated') {
          const replay = await callback(f, flow.state);
          httpOK &&= [200, 409].includes(replay.status);
        }
        stateOK =
          (await poll(async () => {
            const s = await oauthStatus(f, flow.state);
            return s.json?.status === 'error' && !unknownOAuth(s);
          }, f.signal)) && noCredential(f);
      }
      limited = true;
      break;
    }
    case 30: {
      const flow = await beginOAuth(f);
      controlOK = (await oauthStatus(f, flow.state)).json?.status === 'wait';
      r = await f.mgmt(
        'DELETE',
        '/oauth/session' + (variant === 'missing' ? '' : '?state=' + flow.state),
        undefined,
        variant === 'auth' ? null : undefined
      );
      httpOK =
        variant === 'auth'
          ? denial(r, [401])
          : variant === 'missing'
            ? denial(r, [400])
            : r.status === 200 && r.json?.cancelled === true;
      if (['auth', 'missing'].includes(variant))
        stateOK = (await oauthStatus(f, flow.state)).json?.status === 'wait' && noCredential(f);
      else {
        const replay = await callback(f, flow.state);
        stateOK =
          denial(replay, [404]) &&
          unknownOAuth(await oauthStatus(f, flow.state)) &&
          noCredential(f);
        if (variant === 'replay') {
          const cancel = await f.mgmt('DELETE', '/oauth/session?state=' + flow.state);
          stateOK &&= cancel.status === 200 && cancel.json?.cancelled === false;
        }
      }
      limited = true;
      break;
    }
    case 34: {
      if (variant === 'registered') {
        insist((await upload(f)).status === 200);
        controlOK = !!(await listedCredential(f));
      } else controlOK = await control();
      r = await f.mgmt(
        'GET',
        '/credentials/models' +
          (variant === 'missing' ? '' : '?name=' + (variant === 'unknown' ? 'missing.json' : NAME))
      );
      httpOK =
        variant === 'missing'
          ? denial(r, [400])
          : r.status === 200 && Array.isArray(r.json?.models);
      stateOK =
        unchanged() && (variant === 'registered' ? !!(await listedCredential(f)) : noCredential(f));
      limited = true;
      break;
    }
    case 35: {
      r = await f.mgmt(
        'GET',
        '/routing/model-definitions/' + (variant === 'codex' ? 'codex' : 'aq02-unknown')
      );
      httpOK =
        variant === 'unknown'
          ? denial(r, [400])
          : r.status === 200 &&
            r.json?.channel === 'codex' &&
            Array.isArray(r.json?.models) &&
            r.json.models.length > 0 &&
            r.json.models.every((m) => typeof m.id === 'string');
      stateOK = unchanged();
      controlOK = await control();
      limited = true;
      break;
    }
    case 36: {
      controlOK = await control();
      const updated = structuredClone(f.config['api-keys']['openai-compatibility']);
      updated[0].models[0].alias = 'aq02-renamed';
      r = await f.mgmt('PUT', '/config/api-keys/openai-compatibility', updated);
      httpOK = r.status === 200;
      const readback = (await f.mgmt('GET', '/config/api-keys/openai-compatibility')).json;
      stateOK =
        readback?.[0]?.models?.[0]?.alias === 'aq02-renamed' &&
        (await poll(
          async () => successfulData(await f.data(f.clientKey, 'aq02-renamed')),
          f.signal
        )) &&
        (await f.data()).status !== 200;
      limited = true;
      break;
    }
    default:
      throw new Fault('SETUP_FAILED');
  }
  return { response: r, checks: [!!httpOK, !!stateOK, !!controlOK], limited };
}

export async function naturalExpiry(f, now = () => performance.now(), wait = delay) {
  const flow = await beginOAuth(f),
    started = now();
  const first = await oauthStatus(f, flow.state);
  insist(first.status === 200 && first.json?.status === 'wait');
  const points = [{ response: first, at: now(), passed: true }];
  let errorAt = null,
    expired = false;
  try {
    for (let i = 0; i < 148 && now() - started < 37 * 60000; i++) {
      await wait(15000, f.signal);
      const r = await oauthStatus(f, flow.state),
        at = now();
      insist(r.status === 200 && ['wait', 'error'].includes(r.json?.status));
      if (unknownOAuth(r)) {
        // Same live flow, no callback/cancel/restart, and the full renewed TTL.
        const age = at - (errorAt ?? started);
        expired = age >= 30 * 60000;
        points.push({ response: r, at, passed: expired });
        break;
      }
      if (r.json.status === 'error' && errorAt === null) {
        errorAt = at;
        points.push({ response: r, at, passed: at - started >= 5 * 60000 });
      }
    }
    if (errorAt === null) points.splice(1, 0, { response: first, at: now(), passed: false });
    if (points.length < 3) points.push({ response: first, at: now(), passed: false });
    points.push({ response: first, at: now(), passed: expired && noCredential(f) });
    return points;
  } catch (error) {
    // Retain already-observed pending/error facts on cancellation or timeout.
    // Only recordResult converts these private responses into safe trace fields.
    error.points = points;
    throw error;
  }
}

export function selectCases(manifest, caseSet) {
  insist(['management-r2', 'oauth-expiry-r2'].includes(caseSet));
  return manifest.cases.filter(
    (c) =>
      c.id.startsWith('AQ02-') &&
      !['AQ02-M25-real-refresh', 'AQ02-M33-real-exchange'].includes(c.id) &&
      (caseSet === 'oauth-expiry-r2'
        ? c.budgetRef === 'oauth-expiry-r2'
        : c.budgetRef === 'standard-r1')
  );
}

export function createReport(manifest, manifestBytes, selected) {
  const fixtures = new Set(selected.map((s) => s.fixtureRef));
  return {
    schemaVersion: 1,
    contractId: manifest.contractId,
    manifestRevision: manifest.revision,
    manifestSha256: hash(manifestBytes),
    run: {
      id: 'AQ02-' + freshKey(),
      kind: 'upstream-run',
      runnerCommit: null,
      state: 'not_run',
      selectedCaseRefs: selected.map((s) => s.id),
      startedAt: null,
      endedAt: null,
      setupState: 'not_run',
      cleanupState: 'not_run',
      fixtureInputRefs: manifest.fixtures
        .filter((f) => fixtures.has(f.id))
        .map(({ id: fixtureRef, revision, configProfileId, modeProfileId }) => ({
          fixtureRef,
          revision,
          configProfileId,
          modeProfileId,
        })),
    },
    artifactObservation: {
      candidateRef: manifest.candidate.id,
      provenance: 'not-verified',
      observedArchiveSha256: null,
      observedBinarySha256: null,
    },
    results: selected.map((s) => ({
      caseRef: s.id,
      executionState: 'not_run',
      assertionOutcome: 'not_run',
      capability: 'unknown',
      reasonCode: 'NOT_RUN',
      assertions: [],
      evidenceRefs: [],
    })),
    evidence: [],
  };
}

function recordResult(report, result, spec, points, started, evidenceRoot, limited) {
  const records = points.map(({ response, at, passed }, i) => ({
    expectationRef: spec.expectations[i].id,
    outcome: passed ? 'pass' : 'fail',
    observationCode: passed ? 'EXPECTED_MATCH' : 'EXPECTED_MISMATCH',
    httpStatus: response?.status ?? null,
    elapsedMs: Math.max(0, Math.floor(at - started)),
    requestBytes: response?.requestBytes ?? 0,
    responseBytes: response?.responseBytes ?? 0,
  }));
  const id = spec.id + '-TRACE',
    filename = spec.id + '.json';
  const trace = { schemaVersion: 1, runId: report.run.id, caseRef: spec.id, records };
  save(path.join(evidenceRoot, filename), trace);
  result.assertions = records.map(({ expectationRef, outcome, observationCode }) => ({
    expectationRef,
    outcome,
    observationCode,
  }));
  result.evidenceRefs = [id];
  result.executionState = 'completed';
  result.assertionOutcome = records.every((r) => r.outcome === 'pass') ? 'pass' : 'fail';
  result.capability =
    result.assertionOutcome === 'fail' ? 'unknown' : limited ? 'limited' : 'supported';
  result.reasonCode =
    result.assertionOutcome === 'fail' ? 'ASSERTION_FAILED' : limited ? 'COVERAGE_UNKNOWN' : 'NONE';
  report.evidence.push({
    id,
    kind: 'sanitized-trace',
    relativePath: filename,
    sha256: hash(JSON_BYTES(trace)),
  });
}

export function reportExit(report, validation) {
  return validation.validationStatus === 'report_valid' &&
    report.run.state === 'completed' &&
    report.run.setupState === 'ready' &&
    report.run.cleanupState === 'completed' &&
    report.results.every((r) => r.executionState === 'completed' && r.assertionOutcome === 'pass')
    ? 0
    : 1;
}

async function execute(options, manifest, manifestBytes) {
  // Never attempt a host fallback. The only writable mount is a newly allocated
  // private output parent, inspected on the host before this process starts.
  insist(
    process.platform === 'linux' &&
      options.outputParent === '/work' &&
      options.archive === '/input/' + manifest.candidate.assetName &&
      options.manifest === '/run/aq02-manifest.json'
  );
  ownedDirectory('/work');
  insist(readdirSync('/work').length === 0);
  const inspection = JSON.parse(readOwnedFile('/run/aq02-isolation.json', MiB));
  const isolated = checkIsolation(inspection, runtimeIsolation());
  const identity = JSON.parse(readOwnedFile('/opt/aq02/tool-identity.json', 4096, 0));
  insist(
    /^[a-f0-9]{40}$/.test(identity.runnerCommit) &&
      /^3\.(1[1-9]|[2-9]\d)\./.test(identity.python) &&
      identity.node === process.versions.node &&
      identity.libc === process.report.getReport().header.glibcVersionRuntime
  );
  const sources = [
    'run-cpa-v8-qualification.mjs',
    'prepare-cpa-v8-artifact.py',
    'validate-cpa-v8-evidence.mjs',
  ];
  insist(
    sources.every(
      (name) => hash(readOwnedFile(path.join(HERE, name), MiB, 0)) === identity.files[name]
    )
  );
  const selected = selectCases(manifest, options.caseSet),
    report = createReport(manifest, manifestBytes, selected);
  const root = mkdtempSync('/work/run-'),
    evidenceRoot = path.join(root, 'evidence'),
    privateRoot = path.join(root, 'private');
  mkdirSync(evidenceRoot, { mode: 0o700 });
  mkdirSync(privateRoot, { mode: 0o700 });
  save(path.join(root, 'manifest.json'), manifest);
  save(path.join(root, 'isolation.json'), { ...isolated, ...identity });
  report.run.runnerCommit = identity.runnerCommit;
  report.run.startedAt = new Date().toISOString();
  report.run.state = 'aborted';
  report.run.setupState = 'failed';
  report.run.cleanupState = 'completed';
  const started = performance.now(),
    controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  const sliceTimer = setTimeout(
    cancel,
    options.caseSet === 'oauth-expiry-r2' ? 40 * 60000 : 15 * 60000
  );
  let helper, setupError;
  try {
    const setupController = new AbortController();
    const setupTimer = setTimeout(() => setupController.abort(), 120000);
    try {
      helper = spawnOwned(
        '/usr/bin/python3',
        [
          '-I',
          '-B',
          path.join(HERE, 'prepare-cpa-v8-artifact.py'),
          options.archive,
          path.join(privateRoot, 'artifact'),
        ],
        {
          cwd: privateRoot,
          env: childEnvironment(privateRoot),
          signal: AbortSignal.any([controller.signal, setupController.signal]),
          outputLimit: 4096,
          capture: true,
        }
      );
      insist((await helper.closed) === 0 && !helper.fault, helper.fault ?? 'SETUP_FAILED');
    } finally {
      clearTimeout(setupTimer);
      if (helper) await helper.stop();
    }
    const observed = JSON.parse(helper.output());
    insist(
      Object.keys(observed).length === 2 &&
        observed.observedArchiveSha256 === manifest.candidate.declaredSha256 &&
        /^[a-f0-9]{64}$/.test(observed.observedBinarySha256)
    );
    report.artifactObservation = {
      candidateRef: manifest.candidate.id,
      provenance: 'locally-verified',
      ...observed,
    };
    report.run.setupState = 'ready';
    for (let i = 0; i < selected.length; i++) {
      if (controller.signal.aborted) break;
      const spec = selected[i],
        result = report.results[i],
        caseController = new AbortController();
      const caseTimer = setTimeout(
        () => caseController.abort(),
        spec.budgetRef === 'oauth-expiry-r2' ? 37 * 60000 : 90000
      );
      const signal = AbortSignal.any([controller.signal, caseController.signal]);
      let fixture;
      try {
        fixture = await openFixture(
          privateRoot,
          spec,
          path.join(privateRoot, 'artifact/cli-proxy-api'),
          observed.observedBinarySha256,
          signal
        );
        if (spec.budgetRef === 'oauth-expiry-r2')
          recordResult(
            report,
            result,
            spec,
            await naturalExpiry(fixture),
            started,
            evidenceRoot,
            true
          );
        else {
          const resultData = await dispatchManagement(spec, fixture);
          recordResult(
            report,
            result,
            spec,
            resultData.checks.map((passed) => ({
              passed,
              response: resultData.response,
              at: performance.now(),
            })),
            started,
            evidenceRoot,
            resultData.limited
          );
        }
      } catch (error) {
        if (error.points?.length)
          recordResult(report, result, spec, error.points, started, evidenceRoot, true);
        result.executionState = 'aborted';
        result.assertionOutcome = 'error';
        result.capability = 'unknown';
        result.reasonCode = caseController.signal.aborted ? 'TIMEOUT' : safeCode(error);
        if (result.reasonCode === 'CLEANUP_FAILED') report.run.cleanupState = 'failed';
      } finally {
        clearTimeout(caseTimer);
        if (fixture)
          try {
            await fixture.clean();
          } catch {
            report.run.cleanupState = 'failed';
          }
      }
      if (report.run.cleanupState === 'failed') break;
    }
    if (
      report.results.every((r) => r.executionState === 'completed') &&
      report.run.cleanupState === 'completed'
    )
      report.run.state = 'completed';
  } catch (error) {
    setupError = safeCode(error);
    if (setupError === 'CLEANUP_FAILED') report.run.cleanupState = 'failed';
  } finally {
    clearTimeout(sliceTimer);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
    if (setupError && report.run.setupState === 'failed') {
      for (const result of report.results) {
        result.executionState = 'aborted';
        result.assertionOutcome = 'error';
        result.reasonCode = setupError;
      }
    }
    // Preserve private state if child exit was not proved. Never claim its removal.
    if (report.run.cleanupState !== 'failed')
      try {
        rmSync(privateRoot, { recursive: true });
      } catch {
        report.run.cleanupState = 'failed';
      }
    if (report.run.cleanupState === 'failed') report.run.state = 'aborted';
    report.run.endedAt = new Date().toISOString();
  }
  const reportPath = path.join(root, 'report.json');
  save(reportPath, report);
  const validation = validateEvidence({
    manifestPath: path.join(root, 'manifest.json'),
    reportPath,
    evidenceRoot,
  });
  return {
    exitCode: reportExit(report, validation),
    summary: {
      ...validation,
      runState: report.run.state,
      setupState: report.run.setupState,
      cleanupState: report.run.cleanupState,
    },
  };
}

export async function runCli(argv) {
  const options = {};
  const flags = new Map([
    ['--manifest', 'manifest'],
    ['--archive', 'archive'],
    ['--output-parent', 'outputParent'],
    ['--case-set', 'caseSet'],
  ]);
  try {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--run' && options.run === undefined) {
        options.run = true;
        continue;
      }
      const key = flags.get(argv[i]);
      if (!key || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--'))
        return { exitCode: 2, summary: { validationStatus: 'invalid', errorCode: 'USAGE' } };
      options[key] = argv[++i];
    }
    if (
      !options.manifest ||
      (options.run
        ? !options.archive ||
          !options.outputParent ||
          !['management-r2', 'oauth-expiry-r2'].includes(options.caseSet)
        : Object.keys(options).length !== 1)
    )
      return { exitCode: 2, summary: { validationStatus: 'invalid', errorCode: 'USAGE' } };
    const validation = validateEvidence({ manifestPath: options.manifest });
    if (validation.validationStatus !== 'manifest_valid')
      return { exitCode: 1, summary: validation };
    const bytes = readOwnedFile(path.resolve(options.manifest));
    const manifest = JSON.parse(bytes);
    insist(manifest.revision === 'r2' && same(manifest, createManagementManifest()));
    if (!options.run) return { exitCode: 0, summary: validation };
    return await execute(options, manifest, bytes);
  } catch (error) {
    return { exitCode: 1, summary: { validationStatus: 'invalid', errorCode: safeCode(error) } };
  }
}

let isMain = false;
try {
  isMain =
    !!process.argv[1] &&
    (pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url ||
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));
} catch {
  /* no CLI identity */
}
if (isMain) {
  const { exitCode, summary } = await runCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exitCode = exitCode;
}
