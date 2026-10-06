// Inert AQ-05 fixture evaluator. No transport, plugin loader or product policy API.
import { createHash } from 'node:crypto';
import {
  lstatSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createExtensionManifest } from './validate-cpa-v8-evidence.mjs';
import { createReport } from './run-cpa-v8-qualification.mjs';

const MiB = 1024 * 1024;
export const PROTECTED = '/v0/management/cpamp-fixture/read';
export const PUBLIC = '/v0/resource/plugins/cpamp-fixture/status';
const CORE = '/v8/management/config';
const PRIVATE_KEY = 'AQ05_OWNED_CPA_KEY';
const SENTINEL = 'AQ05_PRIVATE_INBOUND_SENTINEL';
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const need = (ok, code = 'DENIED') => {
  if (!ok) fail(code);
};
const safe = (error) =>
  ['DENIED', 'CONFLICT', 'STALE', 'RESPONSE_DENIED', 'INPUT_LIMIT'].includes(error?.code)
    ? error.code
    : 'DENIED';
const fields = (object, keys) =>
  object &&
  Object.getPrototypeOf(object) === Object.prototype &&
  equal(Object.keys(object).sort(), [...keys].sort());

export function canonicalExtensionPath(value) {
  need(typeof value === 'string' && value.length <= 256 && /^\/[A-Za-z0-9/_-]+$/.test(value));
  need(!value.includes('//') && !value.endsWith('/'));
  return value;
}
export function extensionDeclarations() {
  return [
    {
      schema: 1,
      plugin: 'cpamp-fixture',
      source: 'owned-attestation',
      version: '1.0',
      manifest: 'r1',
      trust: 'trusted',
      method: 'GET',
      path: PROTECTED,
      surface: 'protected',
      permission: 'management-read',
      capability: 'read',
    },
    {
      schema: 1,
      plugin: 'cpamp-fixture',
      source: 'owned-attestation',
      version: '1.0',
      manifest: 'r1',
      trust: 'trusted',
      method: 'GET',
      path: PUBLIC,
      surface: 'public',
      permission: 'resource-read',
      capability: 'read',
    },
  ];
}
const bindings = () => ({
  enabled: true,
  installed: true,
  granted: true,
  manifest: 'r1',
  source: 'owned-attestation',
  version: '1.0',
  connection: 'owned-A',
  credential: 'owned-key-A',
  profile: 'r1',
});
const responseJSON = () => ({
  status: 200,
  headers: [
    ['content-type', 'application/json'],
    ['x-content-type-options', 'nosniff'],
  ],
  body: Buffer.from('{"ok":true}'),
});
export function inertResponse(response) {
  need(fields(response, ['status', 'headers', 'body']), 'RESPONSE_DENIED');
  need(
    response.status === 200 &&
      Array.isArray(response.headers) &&
      response.headers.length <= 16 &&
      Buffer.isBuffer(response.body),
    'RESPONSE_DENIED'
  );
  need(response.body.length <= MiB, 'INPUT_LIMIT');
  const headers = new Map();
  let size = 0;
  for (const pair of response.headers) {
    need(
      Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === 'string'),
      'RESPONSE_DENIED'
    );
    const [name, value] = pair;
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    need(size <= 32768, 'INPUT_LIMIT');
    need(
      name === name.toLowerCase() &&
        !headers.has(name) &&
        ['content-type', 'x-content-type-options', 'cache-control'].includes(name) &&
        !/[\r\n\0]/.test(value),
      'RESPONSE_DENIED'
    );
    headers.set(name, value);
  }
  need(
    headers.get('x-content-type-options') === 'nosniff' &&
      (!headers.has('cache-control') || headers.get('cache-control') === 'no-store'),
    'RESPONSE_DENIED'
  );
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    fail('RESPONSE_DENIED');
  }
  if (headers.get('content-type') === 'application/json') {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail('RESPONSE_DENIED');
    }
    need(fields(value, ['ok']) && value.ok === true, 'RESPONSE_DENIED');
    return { ok: true };
  }
  need(headers.get('content-type') === 'text/plain' && text === 'AQ05_OK', 'RESPONSE_DENIED');
  return 'AQ05_OK';
}

export function extensionFixture(declarations = extensionDeclarations()) {
  const routes = new Map(),
    conflicts = new Set(),
    tickets = new WeakMap();
  let validRegistry = true,
    current = bindings(),
    epoch = 0,
    sent = 0,
    delivered = 0;
  const captured = [];
  try {
    need(Array.isArray(declarations) && declarations.length <= 64, 'INPUT_LIMIT');
    for (const raw of declarations) {
      try {
        need(fields(raw, Object.keys(extensionDeclarations()[0])));
        const entry = structuredClone(raw),
          key = `${entry.method} ${canonicalExtensionPath(entry.path)}`;
        if (routes.has(key) || key === `GET ${CORE}`) conflicts.add(key);
        routes.set(key, entry);
        need(
          entry.schema === 1 &&
            entry.plugin === 'cpamp-fixture' &&
            entry.source === 'owned-attestation' &&
            entry.version === '1.0' &&
            entry.manifest === 'r1' &&
            entry.trust === 'trusted'
        );
        need(entry.method === 'GET' && entry.capability === 'read');
        need(
          (entry.path === PROTECTED &&
            entry.surface === 'protected' &&
            entry.permission === 'management-read') ||
            (entry.path === PUBLIC &&
              entry.surface === 'public' &&
              entry.permission === 'resource-read') ||
            entry.path === CORE
        );
      } catch {
        validRegistry = false;
      }
    }
  } catch {
    validRegistry = false;
  }
  const fresh = (record) =>
    record && record.epoch === epoch && epoch === 0 && equal(current, bindings());
  const classify = (method, rawPath) => {
    const route = canonicalExtensionPath(rawPath),
      key = `${method} ${route}`;
    if (conflicts.has(key)) return 'conflict';
    need(validRegistry);
    if (key === `GET ${CORE}`) return 'core-owned';
    return routes.has(key) ? 'plugin-declared' : 'unknown';
  };
  return {
    classify,
    update(name, value) {
      need(Object.hasOwn(current, name));
      current = { ...current, [name]: value };
      epoch++;
    },
    issue(method, rawPath, query = '') {
      need(query === '' && typeof method === 'string' && method === method.toUpperCase());
      const owner = classify(method, rawPath);
      need(owner !== 'conflict', 'CONFLICT');
      need(owner === 'plugin-declared');
      need(epoch === 0 && equal(current, bindings()), 'STALE');
      const token = Object.freeze({});
      tickets.set(token, { entry: routes.get(`${method} ${rawPath}`), epoch, state: 'issued' });
      return token;
    },
    send(token, inbound = {}) {
      const record = tickets.get(token);
      need(fresh(record) && record.state === 'issued', 'STALE');
      need(
        inbound &&
          Object.getPrototypeOf(inbound) === Object.prototype &&
          Object.keys(inbound).length <= 32
      );
      need(
        Object.entries(inbound).every(
          ([k, v]) => typeof v === 'string' && k.length <= 128 && v.length <= 4096
        ),
        'INPUT_LIMIT'
      );
      need(
        !Object.keys(inbound).some((k) =>
          ['x-http-method-override', 'x-method-override', 'x-http-method'].includes(k.toLowerCase())
        )
      );
      need(
        Object.entries(inbound).reduce(
          (total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value) + 4,
          0
        ) <= 32768,
        'INPUT_LIMIT'
      );
      const headers = { accept: 'application/json' };
      if (record.entry.surface === 'protected') headers.authorization = `Bearer ${PRIVATE_KEY}`;
      record.state = 'sent';
      sent++;
      captured.push(headers);
      return token;
    },
    finish(token, response = responseJSON()) {
      const record = tickets.get(token);
      need(fresh(record) && record.state === 'sent', 'STALE');
      // Consume before validating: rejected responses cannot be replayed.
      record.state = 'finished';
      const value = inertResponse(response);
      delivered++;
      return value;
    },
    stats: () => ({ sent, delivered, epoch }),
    headers: () => structuredClone(captured),
    close() {
      captured.length = 0;
      epoch++;
    },
  };
}

export function evaluateExtensionCase(spec) {
  const known = createExtensionManifest().cases.find((c) => c.id === spec.id);
  need(known && equal(spec, known));
  const match = spec.id.match(/^AQ05-G(\d{2})-(.+)$/),
    number = Number(match[1]),
    variant = match[2];
  let declarations = extensionDeclarations(),
    method = 'GET',
    route = PROTECTED,
    query = '',
    inbound = {},
    response = responseJSON();
  let fixture,
    code = 'NONE',
    owner,
    before,
    value;
  const expectedAllow =
    [1, 2, 18, 19, 24].includes(number) ||
    (number === 5 && variant === 'custom') ||
    (number === 22 && ['json', 'text'].includes(variant));
  let expectedSent = expectedAllow
    ? 1
    : [20, 21, 22].includes(number) || (number === 17 && variant.startsWith('late'))
      ? 1
      : 0;
  if (number === 2 || number === 19 || (number === 24 && variant === 'browser')) route = PUBLIC;
  if (number === 3) {
    if (variant === 'absent') declarations = [];
    else route += '-unknown';
  }
  if (number === 4) declarations[0].trust = variant;
  if (number === 5)
    route =
      variant === 'core' ? CORE : variant === 'unknown-v0' ? '/v0/management/config' : PROTECTED;
  if (number === 6) {
    if (variant === 'core-collision') {
      declarations[0].path = CORE;
      route = CORE;
    } else {
      declarations.push(structuredClone(declarations[0]));
      if (variant === 'duplicate') declarations[2].plugin = 'foreign';
    }
  }
  if (number === 7) {
    if (variant === 'plugin') declarations[0].plugin = 'foreign';
    else declarations[1].path = route = '/v0/resource/plugins/foreign/status';
  }
  if (number === 8)
    declarations[0].path = {
      wildcard: PROTECTED + '/*',
      prefix: '/v0/management/cpamp-fixture',
      host: 'https://example.invalid' + PROTECTED,
    }[variant];
  if (number === 9) {
    if (variant === 'override') inbound['X-HTTP-Method-Override'] = 'DELETE';
    else method = variant;
  }
  if (number === 10)
    route = {
      dot: PROTECTED + '/../read',
      'dot-encoded': PROTECTED + '/%2e%2e/read',
      'slash-encoded': PROTECTED.replace('/read', '%2fread'),
      'double-encoded': PROTECTED.replace('/read', '/%2572ead'),
      'encoded-letter': PROTECTED.replace('/read', '/%72ead'),
    }[variant];
  if (number === 11)
    route = {
      backslash: PROTECTED.replace('/read', '\\read'),
      'duplicate-slash': PROTECTED.replace('/read', '//read'),
      'trailing-slash': PROTECTED + '/',
    }[variant];
  if (number === 12) {
    if (variant === 'query') query = 'target=elsewhere';
    else
      route = {
        absolute: 'https://example.invalid' + PROTECTED,
        userinfo: 'https://user@example.invalid' + PROTECTED,
        fragment: PROTECTED + '#fragment',
        control: PROTECTED + '\n',
      }[variant];
  }
  if (number === 13) {
    if (variant === 'capability') declarations[0].capability = 'write';
    else if (variant === 'public-mutation') {
      route = PUBLIC;
      method = 'PUT';
    } else declarations[0].permission = variant === 'missing' ? '' : 'unknown';
  }
  if (number === 18 || number === 19)
    inbound = {
      Authorization: SENTINEL,
      Cookie: SENTINEL,
      'Proxy-Authorization': SENTINEL,
      Host: 'foreign.invalid',
      'X-Forwarded-For': SENTINEL,
      'X-API-Key': SENTINEL,
      'X-CPAMP-Admin': SENTINEL,
    };
  if (number === 20) {
    if (/^\d+$/.test(variant)) response.status = Number(variant);
    else response.headers.push([variant === 'cookie' ? 'set-cookie' : 'location', SENTINEL]);
  }
  if (number === 21) {
    if (variant === 'unsafe-header') response.headers.push(['access-control-allow-origin', '*']);
    else
      response.headers[0][1] = {
        html: 'text/html',
        javascript: 'application/javascript',
        mime: 'application/json; charset=utf-8',
      }[variant];
  }
  if (number === 22) {
    if (variant === 'text') {
      response.headers[0][1] = 'text/plain';
      response.body = Buffer.from('AQ05_OK');
    }
    if (variant === 'body-limit') response.body = Buffer.alloc(MiB + 1);
    if (variant === 'header-limit') response.headers.push(['cache-control', 'x'.repeat(32769)]);
    if (variant === 'status') response.status = 500;
    if (variant === 'shape') response.body = Buffer.from('{"secret":"' + SENTINEL + '"}');
    if (variant === 'invalid-json') response.body = Buffer.from(SENTINEL);
  }
  if (number === 23 && variant === 'policy') declarations[0].unknownPolicy = true;
  if (number === 23 && variant === 'partial-registry') declarations.push({ schema: 1 });
  try {
    fixture = extensionFixture(declarations);
    if (number === 14)
      fixture.update(
        { disabled: 'enabled', uninstalled: 'installed', revoked: 'granted' }[variant],
        false
      );
    if (number === 15 || number === 16) fixture.update(variant, 'changed');
    if (number === 23 && variant === 'stale-grant') fixture.update('granted', false);
    if (number === 23 && variant === 'exception') throw new Error(SENTINEL);
    owner = fixture.classify(method, route);
    const ticket = fixture.issue(method, route, query);
    if (number === 17 && variant.startsWith('queued')) {
      before = bindings().connection;
      fixture.update('connection', 'owned-B');
      if (variant.endsWith('aba')) fixture.update('connection', before);
    }
    fixture.send(ticket, inbound);
    if (number === 17 && variant.startsWith('late')) {
      before = bindings().connection;
      fixture.update('connection', 'owned-B');
      if (variant.endsWith('aba')) fixture.update('connection', before);
    }
    value = fixture.finish(ticket, response);
  } catch (error) {
    code = safe(error);
  }
  const stats = fixture?.stats() ?? { sent: 0, delivered: 0 };
  let decision = expectedAllow ? code === 'NONE' : code !== 'NONE';
  if (number === 5 && variant === 'core') decision &&= owner === 'core-owned';
  if (number === 6) decision &&= owner === 'conflict';
  let dispatch = stats.sent === expectedSent;
  if (number === 18 || number === 19 || number === 24) {
    const headers = fixture.headers();
    dispatch &&=
      !JSON.stringify(headers).includes(SENTINEL) &&
      equal(
        headers[0],
        route === PUBLIC
          ? { accept: 'application/json' }
          : { accept: 'application/json', authorization: `Bearer ${PRIVATE_KEY}` }
      );
  }
  const delivery =
    stats.delivered === (expectedAllow ? 1 : 0) &&
    (!expectedAllow || value === 'AQ05_OK' || value?.ok === true);
  fixture?.close();
  return {
    checks: [decision, dispatch, delivery],
    code,
    sent: stats.sent,
    delivered: stats.delivered,
    trustBoundary:
      number === 24
        ? variant === 'native'
          ? 'native-full-trust'
          : 'browser-no-key'
        : 'fixture-only',
  };
}

function writeExtensionEvidence(parent, runnerCommit) {
  need(/^[a-f0-9]{40}$/.test(runnerCommit));
  need(path.isAbsolute(parent) && realpathSync(parent) === parent);
  const parentStat = lstatSync(parent);
  need(
    parentStat.isDirectory() && parentStat.uid === process.getuid() && !(parentStat.mode & 0o077)
  );
  const root = mkdtempSync(path.join(parent, 'aq05-'));
  const rootStat = lstatSync(root),
    identity = (s) => [s.dev, s.ino, s.mode, s.uid];
  let evidenceIdentity;
  const save = (filename, value) => {
    need(equal(identity(rootStat), identity(lstatSync(root))) && realpathSync(root) === root);
    if (filename.startsWith('evidence/')) {
      const directory = path.join(root, 'evidence');
      need(
        realpathSync(directory) === directory &&
          equal(identity(lstatSync(directory)), evidenceIdentity)
      );
    }
    writeFileSync(path.join(root, filename), encode(value), { flag: 'wx', mode: 0o600 });
  };
  const manifest = createExtensionManifest(),
    bytes = encode(manifest),
    selected = manifest.cases.filter((c) => c.id.startsWith('AQ05-'));
  const report = createReport(manifest, bytes, selected),
    start = performance.now();
  report.run.kind = 'foundation-fixture';
  report.run.runnerCommit = runnerCommit;
  report.run.startedAt = new Date().toISOString();
  report.run.setupState = 'ready';
  const privateRoot = path.join(root, 'private');
  mkdirSync(privateRoot, { mode: 0o700 });
  writeFileSync(path.join(privateRoot, 'sentinel'), SENTINEL, { flag: 'wx', mode: 0o600 });
  const privateIdentity = identity(lstatSync(privateRoot));
  mkdirSync(path.join(root, 'evidence'), { mode: 0o700 });
  evidenceIdentity = identity(lstatSync(path.join(root, 'evidence')));
  save('manifest.json', manifest);
  try {
    for (let index = 0; index < selected.length; index++) {
      need(performance.now() - start < 15 * 60000, 'INPUT_LIMIT');
      const spec = selected[index],
        at = performance.now(),
        evaluated = evaluateExtensionCase(spec),
        result = report.results[index];
      need(performance.now() - at < 90000, 'INPUT_LIMIT');
      const records = spec.expectations.map((expectation, i) => ({
        expectationRef: expectation.id,
        outcome: evaluated.checks[i] ? 'pass' : 'fail',
        observationCode: evaluated.checks[i] ? 'EXPECTED_MATCH' : 'EXPECTED_MISMATCH',
        httpStatus: null,
        elapsedMs: Math.floor(performance.now() - start),
        requestBytes: 0,
        responseBytes: 0,
      }));
      const trace = { schemaVersion: 1, runId: report.run.id, caseRef: spec.id, records },
        filename = spec.id + '.json',
        evidenceId = spec.id + '-TRACE';
      save('evidence/' + filename, trace);
      const passed = records.every((r) => r.outcome === 'pass'),
        guard = spec.proofScope === 'boundary-guard';
      Object.assign(result, {
        executionState: 'completed',
        assertionOutcome: passed ? 'pass' : 'fail',
        capability: passed && guard ? 'supported' : 'unknown',
        reasonCode: !passed ? 'ASSERTION_FAILED' : guard ? 'NONE' : 'COVERAGE_UNKNOWN',
        assertions: records.map(({ expectationRef, outcome, observationCode }) => ({
          expectationRef,
          outcome,
          observationCode,
        })),
        evidenceRefs: [evidenceId],
      });
      report.evidence.push({
        id: evidenceId,
        kind: 'sanitized-trace',
        relativePath: filename,
        sha256: hash(encode(trace)),
      });
    }
    report.run.state = 'completed';
  } catch {
    report.run.state = 'aborted';
  } finally {
    try {
      need(equal(identity(rootStat), identity(lstatSync(root))) && realpathSync(root) === root);
      need(
        realpathSync(privateRoot) === privateRoot &&
          equal(identity(lstatSync(privateRoot)), privateIdentity)
      );
      rmSync(privateRoot, { recursive: true });
      need(!existsSync(privateRoot));
      report.run.cleanupState = 'completed';
    } catch {
      report.run.cleanupState = 'failed';
      report.run.state = 'aborted';
    }
    report.run.endedAt = new Date().toISOString();
    save('report.json', report);
  }
  return { root, manifest, report };
}

export function emitExtensionEvidence(parent, runnerCommit) {
  try {
    return writeExtensionEvidence(parent, runnerCommit);
  } catch (error) {
    fail(safe(error));
  }
}
