import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createExtensionManifest,
  createUsageStageManifest,
  createExternalManifest,
  createManagementManifest,
  createSeedManifest,
  validateEvidence,
} from '../bin/ci/validate-cpa-v8-evidence.mjs';
import {
  canonicalExtensionPath,
  extensionDeclarations,
  extensionFixture,
  evaluateExtensionCase,
  emitExtensionEvidence,
  inertResponse,
  PROTECTED,
  PUBLIC,
} from '../bin/ci/cpa-v8-extension-fixtures.mjs';
const roots = [];
const temp = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cpamp-aq05-')));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const HEAD = 'aacf002b9b80bad3fbebb84f5478ca89cd0ff4ef'; // synthetic unit-test binding, not acceptance
const encode = (value) => JSON.stringify(value, null, 2) + '\n';
const selected = createExtensionManifest().cases.filter((c) => c.id.startsWith('AQ05-'));
function validate(output) {
  return validateEvidence({
    manifestPath: path.join(output.root, 'manifest.json'),
    reportPath: path.join(output.root, 'report.json'),
    evidenceRoot: path.join(output.root, 'evidence'),
  });
}
function saveReport(output) {
  writeFileSync(path.join(output.root, 'report.json'), encode(output.report), { mode: 0o600 });
}
const goodResponse = () => ({
  status: 200,
  headers: [
    ['content-type', 'application/json'],
    ['x-content-type-options', 'nosniff'],
  ],
  body: Buffer.from('{"ok":true}'),
});

describe('AQ-05 fixed catalogue actual decisions and counters', () => {
  it.each(selected)('$id', (spec) => {
    const r = evaluateExtensionCase(spec);
    expect(r.checks).toEqual([true, true, true]);
    expect(JSON.stringify(r)).not.toMatch(/AQ05_PRIVATE|AQ05_OWNED_CPA_KEY/);
  });
  it('preserves original factories and keeps actual extension enable off', () => {
    const m = createExtensionManifest();
    expect(selected).toHaveLength(79);
    expect(new Set(selected.map((c) => c.id.split('-')[1])).size).toBe(24);
    expect(m.cases).toHaveLength(94);
    expect(m.operations).toHaveLength(16);
    expect(m.profiles).toHaveLength(7);
    expect(m.profiles.filter((p) => p.selected)).toHaveLength(5);
    expect(m.operations.find((o) => o.id === 'EXT-ENABLE-01').surfaces).toEqual([]);
    for (const old of [
      createSeedManifest(),
      createManagementManifest(),
      createExternalManifest(),
      createUsageStageManifest(),
    ])
      expect(old.cases.some((c) => c.id.startsWith('AQ05-'))).toBe(false);
  });
});
describe('AQ-05 tool boundaries', () => {
  it.each(['schema', 'field', 'trust', 'source', 'count'])(
    'V-AQ05-01/02 rejects untrusted registry %s',
    (kind) => {
      const entries = extensionDeclarations();
      if (kind === 'schema') entries[0].schema = 2;
      if (kind === 'field') entries[0].unknown = true;
      if (kind === 'trust') entries[0].trust = 'hash-only';
      if (kind === 'source') entries[0].source = 'reported';
      if (kind === 'count') entries.push(...Array(63).fill(entries[0]));
      const f = extensionFixture(entries);
      expect(() => f.issue('GET', PROTECTED)).toThrow();
      expect(f.stats().sent).toBe(0);
    }
  );
  it('V-AQ05-03 rejects duplicate declarations in both orders', () => {
    const entries = extensionDeclarations();
    entries.push({ ...entries[0], plugin: 'foreign' });
    for (const input of [entries, [...entries].reverse()]) {
      const f = extensionFixture(input);
      expect(f.classify('GET', PROTECTED)).toBe('conflict');
      expect(() => f.issue('GET', PROTECTED)).toThrow('CONFLICT');
      expect(f.stats().sent).toBe(0);
    }
  });
  it.each([
    '/%252e%252e',
    '/a?path=x',
    '/a/../b',
    '/a//b',
    '/a\\b',
    '//example.invalid/a',
    'https://example.invalid/a',
    '/a#x',
    '/a/',
    '/a\0',
  ])('V-AQ05-04 rejects raw path %j', (route) =>
    expect(() => canonicalExtensionPath(route)).toThrow()
  );
  it('V-AQ05-05 queued/late ABA never revalidates a ticket and sent effects remain counted', () => {
    for (const late of [false, true]) {
      const f = extensionFixture(),
        ticket = f.issue('GET', PROTECTED);
      if (late) f.send(ticket);
      f.update('connection', 'B');
      f.update('connection', 'owned-A');
      expect(() => (late ? f.finish(ticket) : f.send(ticket))).toThrow('STALE');
      expect(() => f.issue('GET', PROTECTED)).toThrow('STALE');
      expect(f.stats()).toEqual({ sent: late ? 1 : 0, delivered: 0, epoch: 2 });
    }
  });
  it('V-AQ05-05 tickets cannot be forged, sent twice or delivered twice', () => {
    const f = extensionFixture();
    expect(() => f.send({})).toThrow('STALE');
    const ticket = f.issue('GET', PROTECTED);
    f.send(ticket);
    expect(() => f.send(ticket)).toThrow('STALE');
    f.finish(ticket);
    expect(() => f.finish(ticket)).toThrow('STALE');
    expect(f.stats().sent).toBe(1);
  });
  it('V-AQ05-06 rebuilds request headers for both credential classes', () => {
    for (const route of [PROTECTED, PUBLIC]) {
      const f = extensionFixture(),
        ticket = f.issue('GET', route);
      f.send(ticket, {
        aUtHoRiZaTiOn: 'private-admin',
        Cookie: 'private-session',
        Host: 'foreign',
        'Proxy-Authorization': 'private-proxy',
      });
      const headers = f.headers()[0];
      expect(JSON.stringify(headers)).not.toMatch(/private|foreign/);
      expect(Object.keys(headers)).toEqual(
        route === PUBLIC ? ['accept'] : ['accept', 'authorization']
      );
    }
  });
  it.each(['cookie', 'redirect', 'duplicate', 'unsafe', 'html', 'invalid-utf8'])(
    'V-AQ05-07/08 rejects complete response %s',
    (kind) => {
      const r = goodResponse();
      if (kind === 'cookie') r.headers.push(['set-cookie', 'private']);
      if (kind === 'redirect') r.status = 302;
      if (kind === 'duplicate') r.headers.push(['content-type', 'text/plain']);
      if (kind === 'unsafe') r.headers.push(['content-encoding', 'gzip']);
      if (kind === 'html') r.headers[0][1] = 'text/html';
      if (kind === 'invalid-utf8') r.body = Buffer.from([0xff]);
      expect(() => inertResponse(r)).toThrow('RESPONSE_DENIED');
    }
  );
  it('V-AQ05-09 emits only foundation evidence and retains all unexecuted operations', () => {
    const output = emitExtensionEvidence(temp(), HEAD);
    expect(validate(output).validationStatus).toBe('report_valid');
    expect(output.report.run.kind).toBe('foundation-fixture');
    expect(output.report.artifactObservation).toMatchObject({
      provenance: 'not-verified',
      observedArchiveSha256: null,
      observedBinarySha256: null,
    });
    expect(output.report.results).toHaveLength(79);
    expect(output.manifest.cases.filter((c) => !c.id.startsWith('AQ05-'))).toHaveLength(15);
    expect(output.report.run.cleanupState).toBe('completed');
    expect(readdirSync(output.root)).not.toContain('private');
    for (const name of readdirSync(path.join(output.root, 'evidence')))
      expect(readFileSync(path.join(output.root, 'evidence', name), 'utf8')).not.toMatch(
        /AQ05_PRIVATE|AQ05_OWNED_CPA_KEY/
      );
  });
  it.each(['verified', 'hash', 'scope', 'required', 'copied-result', 'config', 'head', 'trace'])(
    'V-AQ05-09/10 rejects %s promotion or mismatched evidence',
    (kind) => {
      const output = emitExtensionEvidence(temp(), HEAD),
        r = output.report;
      if (kind === 'verified') r.artifactObservation.provenance = 'locally-verified';
      if (kind === 'hash') r.artifactObservation.observedArchiveSha256 = 'a'.repeat(64);
      if (kind === 'scope') r.manifestRevision = 'r4';
      if (kind === 'required') r.results[0].assertions.pop();
      if (kind === 'copied-result') r.results[0].caseRef = 'AQ04-S01-snapshot';
      if (kind === 'config') r.run.fixtureInputRefs[0].configProfileId = 'foreign';
      if (kind === 'head') r.run.runnerCommit = 'unknown';
      if (kind === 'trace')
        writeFileSync(path.join(output.root, 'evidence', r.evidence[0].relativePath), '{}');
      saveReport(output);
      expect(validate(output).validationStatus).toBe('invalid');
    }
  );
  it('V-AQ05-11 refuses symlink/unowned-mode roots and preserves existing output', () => {
    const parent = temp(),
      original = emitExtensionEvidence(parent, HEAD),
      before = readFileSync(path.join(original.root, 'report.json'));
    const next = emitExtensionEvidence(parent, HEAD);
    expect(next.root).not.toBe(original.root);
    expect(readFileSync(path.join(original.root, 'report.json'))).toEqual(before);
    const link = path.join(temp(), 'alias');
    symlinkSync(parent, link);
    expect(() => emitExtensionEvidence(link, HEAD)).toThrow();
    chmodSync(parent, 0o755);
    expect(() => emitExtensionEvidence(parent, HEAD)).toThrow();
    chmodSync(parent, 0o700);
  });
  it('V-AQ05-11 cleanup failure remains aborted and cannot become completed', () => {
    const out = emitExtensionEvidence(temp(), HEAD);
    out.report.run.cleanupState = 'failed';
    out.report.run.state = 'aborted';
    saveReport(out);
    expect(validate(out)).toMatchObject({ validationStatus: 'report_valid', cleanupFailures: 1 });
    out.report.run.state = 'completed';
    saveReport(out);
    expect(validate(out).validationStatus).toBe('invalid');
  });
  it('V-AQ05-08 counts UTF-8 request bytes before any target send', () => {
    const f = extensionFixture(),
      ticket = f.issue('GET', PROTECTED);
    const inbound = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => ['field' + i, '界'.repeat(3000)])
    );
    expect(() => f.send(ticket, inbound)).toThrow('INPUT_LIMIT');
    expect(f.stats().sent).toBe(0);
  });
  it.each(['cleanup', 'evidence-drift'])('V-AQ05-11 observes actual %s failure', (kind) => {
    const parent = temp();
    const script = `import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';import {pathToFileURL} from 'node:url';
      const write=fs.writeFileSync,remove=fs.rmSync;const outside=path.join(process.argv[2],'outside');fs.mkdirSync(outside,{mode:448});
      if(process.argv[3]==='cleanup')fs.rmSync=(file,...args)=>{if(file.endsWith('/private'))throw Error('private failure');return remove(file,...args)};
      else fs.writeFileSync=(file,...args)=>{const r=write(file,...args);if(file.endsWith('/manifest.json')){const evidence=path.join(path.dirname(file),'evidence');fs.renameSync(evidence,evidence+'-old');fs.symlinkSync(outside,evidence)}return r};
      syncBuiltinESMExports();const{emitExtensionEvidence}=await import(pathToFileURL(process.argv[1]));const output=emitExtensionEvidence(process.argv[2],process.argv[4]);
      process.stdout.write(JSON.stringify({state:output.report.run.state,cleanup:output.report.run.cleanupState,outside:fs.readdirSync(outside)}));`;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        path.resolve('bin/ci/cpa-v8-extension-fixtures.mjs'),
        parent,
        kind,
        HEAD,
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({
      state: 'aborted',
      cleanup: kind === 'cleanup' ? 'failed' : 'completed',
      outside: [],
    });
  });
  it('V-AQ05-08 filesystem errors do not echo caller paths', () => {
    const missing = path.join(temp(), 'AQ05_PRIVATE_PATH_SENTINEL');
    let message;
    try {
      emitExtensionEvidence(missing, HEAD);
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe('DENIED');
  });
  it('V-AQ05-12 evaluator cannot call a transport or process spawn', () => {
    const entry = path.resolve('bin/ci/cpa-v8-extension-fixtures.mjs');
    const script = `import http from 'node:http';import https from 'node:https';import net from 'node:net';import cp from 'node:child_process';import {syncBuiltinESMExports}from'node:module';import{pathToFileURL}from'node:url';const trap=()=>{throw Error('forbidden')};http.request=https.request=net.connect=cp.spawn=cp.spawnSync=trap;globalThis.fetch=trap;syncBuiltinESMExports();const{evaluateExtensionCase}=await import(pathToFileURL(process.argv[1]));const{createExtensionManifest}=await import(pathToFileURL(process.argv[2]));const results=createExtensionManifest().cases.filter(c=>c.id.startsWith('AQ05-')).map(evaluateExtensionCase);process.stdout.write(JSON.stringify({pass:results.every(r=>r.checks.every(Boolean)),count:results.length}));`;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        entry,
        path.resolve('bin/ci/validate-cpa-v8-evidence.mjs'),
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({ pass: true, count: 79 });
  });
});
