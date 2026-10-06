// Fixed, private AQ-03 fixtures. This is not a production External client.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createGunzip, gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const LIMIT = 1024 * 1024;
const ROUTE = '/v8/management/config';
const targets = new WeakSet();
const fault = (code) => Object.assign(new Error(code), { code });
const requireThat = (ok, code = 'SETUP_FAILED') => {
  if (!ok) throw fault(code);
};
const dangerousEnv =
  /^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|node_extra_ca_certs|node_tls_reject_unauthorized)$/i;
export function cleanExternalEnvironment(env, argv = []) {
  requireThat(!Object.keys(env).some((k) => dangerousEnv.test(k) && env[k]), 'AUTH_REJECTED');
  requireThat(
    !argv.some((v) =>
      /--(?:require|import|use-env-proxy|use-system-ca|use-openssl-ca|openssl-config)/.test(v)
    ),
    'AUTH_REJECTED'
  );
}

export function validateExternalURL(raw) {
  requireThat(typeof raw === 'string' && !/[\s\\\x00-\x1f\x7f%@?#]/.test(raw), 'AUTH_REJECTED');
  const match = /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+):([0-9]+)(\/fixture)?$/.exec(raw);
  requireThat(match && !raw.includes('/.') && !raw.includes('..'), 'AUTH_REJECTED');
  const host = match[2].replace(/^\[|\]$/g, '');
  requireThat(
    ['cpa.invalid', 'localhost', '127.0.0.1', '::1', '10.0.0.7'].includes(host),
    'AUTH_REJECTED'
  );
  const port = +match[3];
  requireThat(port > 0 && port <= 65535 && String(port) === match[3], 'AUTH_REJECTED');
  return { scheme: match[1], host, port, prefix: match[4] ?? '' };
}

export function externalTarget({
  port,
  host = 'cpa.invalid',
  address = '127.0.0.1',
  tls = false,
  ca,
  prefix = '',
  controlled = true,
  proxy = false,
  lookupDelay = 0,
  lookupFailure = false,
}) {
  requireThat(controlled && !proxy && ['127.0.0.1', '::1'].includes(address), 'AUTH_REJECTED');
  const raw = `${tls ? 'https' : 'http'}://${net.isIP(host) === 6 ? '[' + host + ']' : host}:${port}${prefix}`;
  const parsed = validateExternalURL(raw);
  requireThat(!tls || typeof ca === 'string' || Buffer.isBuffer(ca), 'TLS_INVALID');
  const target = Object.freeze({ ...parsed, address, ca, lookupDelay, lookupFailure });
  targets.add(target);
  return target;
}

export function externalRead(
  target,
  { key, method = 'GET', route = ROUTE, signal, timeoutMs = 5000, env = {}, argv = [] } = {}
) {
  requireThat(targets.has(target), 'AUTH_REJECTED');
  cleanExternalEnvironment(env, argv);
  requireThat(method === 'GET' && route === ROUTE, 'AUTH_REJECTED');
  requireThat(
    timeoutMs > 0 && timeoutMs <= 5000 && (key == null || /^[a-zA-Z0-9_-]{1,256}$/.test(key)),
    'INPUT_LIMIT'
  );
  return new Promise((resolve, reject) => {
    const secure = target.scheme === 'https';
    const agent = secure
      ? new https.Agent({ keepAlive: false, maxCachedSessions: 0 })
      : new http.Agent({ keepAlive: false });
    let request,
      response,
      decoder,
      timer,
      dnsTimer,
      done = false,
      encoded = 0,
      decoded = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(dnsTimer);
      signal?.removeEventListener('abort', abort);
      decoder?.destroy();
      response?.destroy();
      request?.destroy();
      agent.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(fault('CANCELLED'));
    const lookup = (_name, options, callback) => {
      const complete = () => {
        if (done) return;
        if (target.lookupFailure)
          callback(Object.assign(new Error('fixture'), { code: 'ENOTFOUND' }));
        else
          callback(
            null,
            options.all
              ? [{ address: target.address, family: net.isIP(target.address) }]
              : target.address,
            net.isIP(target.address)
          );
      };
      if (target.lookupDelay) dnsTimer = setTimeout(complete, target.lookupDelay);
      else complete();
    };
    timer = setTimeout(() => finish(fault('TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    request = (secure ? https : http).request(
      {
        hostname: net.isIP(target.host) ? target.address : target.host,
        port: target.port,
        path: target.prefix + route,
        method: 'GET',
        agent,
        lookup,
        autoSelectFamily: false,
        ca: target.ca,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) =>
          tls.checkServerIdentity(target.host, certificate),
        ...(secure && !net.isIP(target.host) ? { servername: target.host } : {}),
        maxHeaderSize: 32768,
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity, gzip',
          ...(key == null ? {} : { authorization: `Bearer ${key}` }),
        },
      },
      (incoming) => {
        response = incoming;
        if (incoming.statusCode >= 300 && incoming.statusCode <= 399)
          return finish(fault('REDIRECT_BLOCKED'));
        if ([401, 403].includes(incoming.statusCode)) return finish(fault('AUTH_REJECTED'));
        if (incoming.statusCode !== 200) return finish(fault('CAPABILITY_MISSING'));
        const encoding = incoming.headers['content-encoding'] ?? 'identity';
        if (!['identity', 'gzip'].includes(encoding)) return finish(fault('BODY_SCHEMA_MISMATCH'));
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            incoming.headers['content-type'] ?? ''
          )
        )
          return finish(fault('BODY_SCHEMA_MISMATCH'));
        const stream = encoding === 'gzip' ? (decoder = createGunzip()) : incoming;
        incoming.on('data', (chunk) => {
          encoded += chunk.length;
          if (encoded > LIMIT) finish(fault('INPUT_LIMIT'));
        });
        incoming.on('aborted', () => finish(fault('BODY_SCHEMA_MISMATCH')));
        incoming.on('error', () => finish(fault('BODY_SCHEMA_MISMATCH')));
        stream.on('error', () => finish(fault('BODY_SCHEMA_MISMATCH')));
        stream.on('data', (chunk) => {
          decoded += chunk.length;
          if (decoded > LIMIT) finish(fault('INPUT_LIMIT'));
          else chunks.push(chunk);
        });
        stream.on('end', () => {
          if (done) return;
          if (!incoming.complete) return finish(fault('BODY_SCHEMA_MISMATCH'));
          try {
            const value = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
            );
            requireThat(
              value?.['config-version'] === 8 &&
                Number.isInteger(value?.server?.port) &&
                value.server.port > 0 &&
                value.server.port <= 65535 &&
                typeof value?.oauth?.['auth-dir'] === 'string' &&
                value.oauth['auth-dir'].length > 0 &&
                Array.isArray(value?.access?.['api-keys']) &&
                value.access['api-keys'].every((v) => typeof v === 'string'),
              'BODY_SCHEMA_MISMATCH'
            );
            finish(null, {
              status: 200,
              json: value,
              reported: { version: incoming.headers['x-cpa-version'] ?? null },
              requestBytes: 0,
              responseBytes: encoded,
            });
          } catch {
            finish(fault('BODY_SCHEMA_MISMATCH'));
          }
        });
        if (decoder) incoming.pipe(decoder);
      }
    );
    request.on('socket', (socket) =>
      socket.once('connect', () => {
        if (socket.remoteAddress?.replace(/^::ffff:/, '') !== target.address)
          finish(fault('AUTH_REJECTED'));
      })
    );
    request.on('error', (e) =>
      finish(
        fault(
          e.code === 'HPE_HEADER_OVERFLOW'
            ? 'INPUT_LIMIT'
            : /CERT|TLS|SSL|SELF_SIGNED|VERIFY/.test(e.code ?? '')
              ? 'TLS_INVALID'
              : 'TARGET_UNREACHABLE'
        )
      )
    );
    request.end();
  });
}

export function bindingFence(initial) {
  let revision = 0,
    current = structuredClone(initial),
    active = null;
  return {
    capture: () => ({ revision, binding: JSON.stringify(current) }),
    change(next) {
      active?.abort();
      active = null;
      revision++;
      current = structuredClone(next);
    },
    signal() {
      active?.abort();
      active = new AbortController();
      return active.signal;
    },
    publish(ticket, value) {
      return ticket.revision === revision && ticket.binding === JSON.stringify(current)
        ? value
        : null;
    },
  };
}
export function projectRequired(required, facts) {
  requireThat(
    Array.isArray(required) &&
      required.length > 0 &&
      new Set(required).size === required.length &&
      Array.isArray(facts) &&
      new Set(facts.map((f) => f.id)).size === facts.length
  );
  const selected = required.map((id) => facts.find((f) => f.id === id));
  const supported = (f) =>
    f?.accepted === true &&
    f.proofScope === 'upstream-function' &&
    f.outcome === 'pass' &&
    f.capability === 'supported';
  const complete = selected.every(supported);
  return {
    ready: complete,
    state: complete
      ? 'compatible'
      : selected.some(
            (f) =>
              f?.accepted === true &&
              f.proofScope === 'upstream-function' &&
              f.capability === 'unsupported'
          )
        ? 'unsupported'
        : selected.some(
              (f) =>
                f?.accepted === true &&
                f.proofScope === 'upstream-function' &&
                f.outcome === 'pass' &&
                ['supported', 'limited'].includes(f.capability)
            )
          ? 'partial'
          : 'unknown',
  };
}

export function externalCertificates(root) {
  const folder = path.join(root, 'external-tls');
  mkdirSync(folder, { mode: 0o700 });
  const run = (args) => {
    const result = spawnSync('/usr/bin/openssl', args, {
      cwd: folder,
      env: { PATH: '/usr/bin:/bin', HOME: folder },
      timeout: 5000,
      stdio: 'ignore',
    });
    requireThat(result.status === 0 && !result.error);
  };
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=AQ03 Owned CA',
  ]);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=cpa.invalid',
  ]);
  writeFileSync(
    path.join(folder, 'extensions'),
    'subjectAltName=DNS:cpa.invalid,DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n',
    { mode: 0o600 }
  );
  run([
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'leaf.pem',
    '-days',
    '2',
    '-extfile',
    'extensions',
  ]);
  writeFileSync(path.join(folder, 'index'), '', { mode: 0o600 });
  writeFileSync(path.join(folder, 'serial'), '1000\n', { mode: 0o600 });
  writeFileSync(
    path.join(folder, 'ca.conf'),
    '[ca]\ndefault_ca=local\n[local]\ndatabase=index\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\npolicy=policy\nx509_extensions=extensions\n[policy]\ncommonName=supplied\n[extensions]\nsubjectAltName=DNS:cpa.invalid,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n',
    { mode: 0o600 }
  );
  run([
    'ca',
    '-batch',
    '-config',
    'ca.conf',
    '-in',
    'leaf.csr',
    '-out',
    'expired.pem',
    '-startdate',
    '20000101000000Z',
    '-enddate',
    '20000102000000Z',
  ]);
  return Object.fromEntries(
    ['ca.pem', 'leaf.key', 'leaf.pem', 'expired.pem'].map((name) => [
      name,
      readFileSync(path.join(folder, name)),
    ])
  );
}

export async function externalServer(handler, { tls, host = '127.0.0.1', raw = false } = {}) {
  let requests = 0,
    credentials = 0;
  const sockets = new Set();
  const server = raw
    ? net.createServer()
    : (tls ? https : http).createServer(tls ?? {}, (req, res) => {
        requests++;
        if (req.headers.authorization) credentials++;
        handler(req, res);
      });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return {
    port: server.address().port,
    get requests() {
      return requests;
    },
    get credentials() {
      return credentials;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fault('CLEANUP_FAILED')), 2000);
        server.close((e) => {
          clearTimeout(timer);
          if (e) reject(fault('CLEANUP_FAILED'));
          else resolve();
        });
      });
    },
  };
}

const sample = () => ({
  'config-version': 8,
  server: { port: 8317 },
  oauth: { 'auth-dir': '/private/fixture' },
  access: { 'api-keys': [] },
});
const reply = (res, value = sample()) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};
const rejected = async (work, code) => {
  try {
    await work();
    return false;
  } catch (e) {
    return e.code === code;
  }
};

// Each recipe has a fixed positive control and a response/state/cleanup check.
export async function dispatchExternal(spec, f) {
  const [, text, variant] = /^AQ03-E(\d\d)-(.+)$/.exec(spec.id) ?? [];
  const group = +text;
  requireThat(group >= 1 && group <= 28);
  const cleanups = [];
  let r,
    passed = false,
    control = true;
  const serve = async (handler = (_req, res) => reply(res), options) => {
    const s = await externalServer(handler, options);
    cleanups.push(() => s.close());
    return s;
  };
  const read = (target, options = {}) =>
    externalRead(target, { key: f.managementKey, signal: f.signal, env: {}, ...options });
  const target = (server, options = {}) => externalTarget({ port: server.port, ...options });
  try {
    if ([1, 2, 15].includes(group) && variant.startsWith('real')) {
      const before = readFileSync(f.filename);
      let t = externalTarget({ port: f.config.server.port });
      if (group === 2) {
        const certs = externalCertificates(f.root);
        const front = await serve(
          async (req, res) => {
            try {
              const v = await f.mgmt('GET', '/config', undefined, null, {
                authorization: req.headers.authorization,
              });
              res.statusCode = v.status;
              reply(res, v.json);
            } catch {
              res.destroy();
            }
          },
          { tls: { key: certs['leaf.key'], cert: certs['leaf.pem'] } }
        );
        t = target(front, { tls: true, ca: certs['ca.pem'] });
      }
      if (group === 15) {
        control = (await read(t)).json.server.port === f.config.server.port;
        passed = await rejected(
          () => read(t, { key: variant === 'real-missing' ? null : 'wrong_fixture_key' }),
          'AUTH_REJECTED'
        );
      } else {
        r = await read(t);
        passed =
          r.json.server.port === f.config.server.port && r.json.oauth['auth-dir'] === f.authDir;
      }
      return {
        response: r,
        checks: [passed, before.equals(readFileSync(f.filename)), control],
        limited: group !== 1,
      };
    }
    const positive = await serve();
    control = (await read(target(positive))).status === 200;
    if ([3, 4, 9].includes(group)) {
      if (variant === 'remote' || variant === 'proxy')
        passed = await rejected(
          () =>
            externalTarget({
              port: positive.port,
              controlled: variant !== 'remote',
              proxy: variant === 'proxy',
            }),
          'AUTH_REJECTED'
        );
      else {
        const s = await serve((req, res) =>
          req.url === (variant === 'prefix' ? '/fixture' : '') + ROUTE
            ? reply(res)
            : ((res.statusCode = 404), res.end())
        );
        r = await read(
          target(s, {
            prefix: variant === 'prefix' ? '/fixture' : '',
            host: variant === 'private' ? '10.0.0.7' : 'cpa.invalid',
          })
        );
        passed = r.status === 200;
      }
    } else if ([2, 5, 10, 11, 12, 21].includes(group)) {
      const certs = externalCertificates(f.root);
      const valid = await serve(undefined, {
        tls: { key: certs['leaf.key'], cert: certs['leaf.pem'] },
      });
      control &&= (await read(target(valid, { tls: true, ca: certs['ca.pem'] }))).status === 200;
      const s = await serve(undefined, {
        host: group === 5 ? '::1' : '127.0.0.1',
        tls: { key: certs['leaf.key'], cert: certs[group === 11 ? 'expired.pem' : 'leaf.pem'] },
      });
      const t = target(s, {
        tls: true,
        ca: group === 10 ? certs['leaf.pem'] : certs['ca.pem'],
        host: group === 5 ? '::1' : group === 12 ? '10.0.0.7' : 'cpa.invalid',
        address: group === 5 ? '::1' : '127.0.0.1',
      });
      if ([10, 11, 12].includes(group))
        passed =
          (await rejected(() => read(t), 'TLS_INVALID')) && s.requests === 0 && s.credentials === 0;
      else {
        r = await read(t);
        passed = r.status === 200 && s.requests === 1 && s.credentials === 1;
      }
    } else if ([6, 7].includes(group)) {
      const routes =
        group === 6
          ? [
              '/v8/management/usage-queue',
              '/v8/management/oauth/auth-url',
              '/v8/management/oauth/callback',
              '/v8/management/credentials/download',
              '/v8/management/credentials/refresh',
              '/v8/management/api-call',
              '/v8/management/plugins/install',
              '/v8/management/plugins/fetch',
              '/v8/management/cooldown/reset',
            ]
          : ['/v1/models', '/v0/management/config', '/latest-version', '/health', '/unknown'];
      const before = positive.requests;
      passed = true;
      for (const route of routes)
        passed &&= await rejected(() => read(target(positive), { route }), 'AUTH_REJECTED');
      if (group === 7)
        for (const method of ['PUT', 'PATCH', 'POST', 'DELETE', 'HEAD', 'OPTIONS'])
          passed &&= await rejected(() => read(target(positive), { method }), 'AUTH_REJECTED');
      passed &&= positive.requests === before;
    } else if (group === 8) {
      const raws = [
        'http://user@cpa.invalid:80',
        'http://127.1:80',
        'http://0177.0.0.1:80',
        'http://0x7f000001:80',
        'http://2130706433:80',
        'http://cpa.invalid:80?key=secret',
        'http://cpa.invalid:80#fragment',
        'http://cpa.invalid:80/../fixture',
        'http://cpa.invalid:80/%2e',
        'http://cpa.invalid:80\\x',
        'ftp://cpa.invalid:80',
        'http://cpa.invalid:080',
        'http://cpa.invalid:80/fixture/',
      ];
      passed = true;
      for (const raw of raws)
        passed &&= await rejected(() => validateExternalURL(raw), 'AUTH_REJECTED');
    } else if ([13, 14].includes(group)) {
      const destination = await serve();
      const codes = group === 13 ? [301, 302, 303, 307, 308] : [302];
      passed = true;
      const certs = variant === 'downgrade' ? externalCertificates(f.root) : null;
      for (const code of codes) {
        const s = await serve(
          (_req, res) => {
            res.statusCode = code;
            res.setHeader(
              'location',
              group === 13
                ? '/leak'
                : `http://${variant === 'userinfo' ? 'secret@' : ''}127.0.0.1:${destination.port}/leak?secret=private`
            );
            res.end();
          },
          certs ? { tls: { key: certs['leaf.key'], cert: certs['leaf.pem'] } } : undefined
        );
        passed &&=
          (await rejected(
            () => read(target(s, certs ? { tls: true, ca: certs['ca.pem'] } : {})),
            'REDIRECT_BLOCKED'
          )) && s.requests === 1;
      }
      passed &&= destination.requests === 0 && destination.credentials === 0;
    } else if (group === 15) {
      const s = await serve((_req, res) => {
        res.statusCode = variant === 'denied' ? 401 : 403;
        res.end();
      });
      passed = (await rejected(() => read(target(s)), 'AUTH_REJECTED')) && s.requests === 1;
    } else if ([16, 17].includes(group)) {
      const s = await serve(
        (_req, res) => {
          if (variant === 'body') {
            res.setHeader('content-type', 'application/json');
            res.write('{');
          }
        },
        { raw: variant === 'tls' }
      );
      if (group === 16 && variant === 'refused') {
        await cleanups.pop()();
      }
      const certs = variant === 'tls' ? externalCertificates(f.root) : null;
      const t = target(s, {
        lookupDelay: group === 17 && variant === 'dns' ? 1000 : 0,
        lookupFailure: group === 16 && variant === 'dns',
        ...(certs ? { tls: true, ca: certs['ca.pem'] } : {}),
      });
      passed = await rejected(
        () => read(t, { timeoutMs: 100 }),
        group === 16 ? 'TARGET_UNREACHABLE' : 'TIMEOUT'
      );
    } else if (group === 18) {
      const s = await serve((_req, res) => {
        res.setHeader('x-large', 'x'.repeat(33000));
        reply(res);
      });
      passed = await rejected(() => read(target(s)), 'INPUT_LIMIT');
    } else if ([19, 20].includes(group)) {
      const s = await serve((_req, res) => {
        res.setHeader('content-type', 'application/json');
        if (group === 19) {
          const body = Buffer.from(JSON.stringify({ ...sample(), padding: 'x'.repeat(LIMIT) }));
          if (variant === 'gzip') {
            res.setHeader('content-encoding', 'gzip');
            res.end(gzipSync(body));
          } else res.end(body);
        } else if (variant === 'encoding') {
          res.setHeader('content-encoding', 'br');
          res.end('private');
        } else if (variant === 'gzip') {
          res.setHeader('content-encoding', 'gzip');
          res.end('private');
        } else if (variant === 'utf8') res.end(Buffer.from([0xff]));
        else if (variant === 'json') res.end('{');
        else if (variant === 'truncated') {
          res.setHeader('content-length', '100');
          res.end('{}');
          setTimeout(() => res.destroy(), 20);
        } else reply(res, { 'config-version': 8, server: { port: '8317' } });
      });
      passed = await rejected(
        () => read(target(s)),
        group === 19 ? 'INPUT_LIMIT' : 'BODY_SCHEMA_MISMATCH'
      );
    } else if ([22, 26, 27].includes(group)) {
      const fence = bindingFence({
        target: 'A',
        credential: 1,
        config: 1,
        mode: 1,
        profile: 1,
        identity: 1,
      });
      const second = await serve();
      const ticket = fence.capture();
      const sig = fence.signal();
      let acknowledge;
      const received = new Promise((resolve) => {
        acknowledge = resolve;
      });
      const delayed = await serve((_req, res) => {
        acknowledge();
        const timer = setTimeout(() => reply(res), 30);
        res.once('close', () => clearTimeout(timer));
      });
      // Simulate a response that wins a cancellation race: it must still fail
      // publication after the binding changes, even when A returns to A.
      const response = read(target(delayed));
      await Promise.race([received, response]);
      fence.change({ target: 'B', credential: 2, config: 2, mode: 2, profile: 2, identity: 2 });
      if (group === 26)
        fence.change({ target: 'A', credential: 1, config: 1, mode: 1, profile: 1, identity: 1 });
      passed =
        sig.aborted &&
        (await response).status === 200 &&
        fence.publish(ticket, true) === null &&
        delayed.requests === 1 &&
        fence.publish(fence.capture(), true) === true &&
        second.requests === 0;
    } else if (group === 23) {
      passed = true;
      const before = positive.requests;
      for (const name of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NODE_OPTIONS',
        'NODE_USE_ENV_PROXY',
        'NODE_EXTRA_CA_CERTS',
        'NODE_TLS_REJECT_UNAUTHORIZED',
      ])
        passed &&= await rejected(
          () => read(target(positive), { env: { [name]: 'private' } }),
          'AUTH_REJECTED'
        );
      passed &&= positive.requests === before;
    } else if (group === 24) {
      const s = await serve((_req, res) => {
        res.setHeader('x-cpa-version', 'counterfeit');
        reply(res);
      });
      r = await read(target(s));
      passed =
        r.reported.version === 'counterfeit' &&
        !('observedBinarySha256' in r) &&
        !('capability' in r);
    } else if (group === 25) {
      const fact = {
        id: 'read',
        accepted: true,
        outcome: 'pass',
        proofScope: 'upstream-function',
        capability: 'supported',
      };
      passed =
        projectRequired(['read'], [fact]).ready &&
        !projectRequired(['read', 'write'], [fact]).ready &&
        projectRequired(['read'], [{ ...fact, proofScope: 'harness-behavior' }]).state ===
          'unknown' &&
        projectRequired(['read'], [{ ...fact, capability: 'unsupported' }]).state === 'unsupported';
    } else if (group === 28) {
      const s = await serve(() => {});
      const controller = new AbortController();
      const request = read(target(s), { signal: controller.signal });
      controller.abort();
      passed = await rejected(() => request, 'CANCELLED');
    }
    return { response: r, checks: [!!passed, !!control, true], limited: true };
  } finally {
    let failed = false;
    for (const close of cleanups.reverse())
      try {
        await close();
      } catch {
        failed = true;
      }
    if (failed) throw fault('CLEANUP_FAILED');
  }
}
