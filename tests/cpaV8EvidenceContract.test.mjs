import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSeedManifest,
  createManagementManifest,
  createExternalManifest,
  validateEvidence,
} from '../bin/ci/validate-cpa-v8-evidence.mjs';

describe('AQ-02 r2 immutable scope and r1 compatibility', () => {
  it('keeps the checked-in r3 manifest canonical and retains the frozen r2 catalogue', () => {
    expect(readFileSync(seedFile)).toEqual(encode(createExternalManifest()));
    manifest = createManagementManifest();
    expect(check().validationStatus).toBe('manifest_valid');
  });
  it.each(['drop-case', 'optional', 'payload-id', 'long-budget', 'base', 'profile', 'surface'])(
    'rejects r2 %s scope drift',
    (kind) => {
      manifest = createManagementManifest();
      const c = manifest.cases.find((item) => item.id === 'AQ02-M01-bearer');
      if (kind === 'drop-case') manifest.cases = manifest.cases.filter((item) => item !== c);
      if (kind === 'optional') c.expectations[0].mandatory = false;
      if (kind === 'payload-id') c.id = 'AQ02-M01-arbitrary';
      if (kind === 'long-budget') c.budgetRef = 'oauth-expiry-r2';
      if (kind === 'base')
        manifest.cpampBaselineCommit = '5bb3a5b88e234a2e8315af694388e72bc0bfe804';
      if (kind === 'profile') manifest.profiles[0].requiredOperationRefs.pop();
      if (kind === 'surface') manifest.operations[0].surfaces[0].pathTemplate = '/arbitrary';
      expect(check().validationStatus).toBe('invalid');
    }
  );
});

describe('AQ-01 observed tool boundaries', () => {
  it.each([{ nodeFlags: [] }, { nodeFlags: ['--preserve-symlinks-main'] }])(
    'runs the CLI through a symlink with $nodeFlags',
    ({ nodeFlags }) => {
      persist(manifestPath, manifest);
      const alias = path.join(root, 'validator-alias.mjs');
      symlinkSync(cli, alias);
      const run = (args) =>
        spawnSync(process.execPath, [...nodeFlags, alias, ...args], {
          encoding: 'utf8',
          timeout: 10000,
        });
      const valid = run(['--manifest', manifestPath]);
      expect(valid.status).toBe(0);
      expect(JSON.parse(valid.stdout).validationStatus).toBe('manifest_valid');
      expect(valid.stderr).toBe('');
      const rejected = run(['--execute']);
      expect(rejected.status).toBe(2);
      invalid(JSON.parse(rejected.stdout), 'USAGE');
      expect(rejected.stderr).toBe('');
    }
  );
  it('V24 validates with network, subprocess and filesystem writes trapped', () => {
    const r = runtimeShapedReport();
    persist(manifestPath, manifest);
    persist(reportPath, r);
    const script = [
      "import fs from 'node:fs';",
      "import http from 'node:http'; import https from 'node:https';",
      "import net from 'node:net'; import dns from 'node:dns'; import cp from 'node:child_process';",
      "import {syncBuiltinESMExports} from 'node:module'; import {pathToFileURL} from 'node:url';",
      "const modulePath=process.argv[1];process.argv[1]='aq01-harness';const {validateEvidence}=await import(pathToFileURL(modulePath).href);",
      "const calls=[]; const trap=label=>()=>{calls.push(label);throw Error('SIDE_EFFECT');};",
      'for(const [name,mod,methods] of [',
      "['fs',fs,['writeFileSync','writeFile','appendFileSync','appendFile','mkdirSync','mkdir','unlinkSync','unlink','renameSync','rename','rmSync','rm','createWriteStream','writeSync','write']],",
      "['http',http,['request','get','createServer']],['https',https,['request','get','createServer']],",
      "['net',net,['connect','createConnection','createServer']],['dns',dns,['lookup','resolve']],",
      "['child',cp,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]])",
      "for(const method of methods) mod[method]=trap(name+'.'+method);",
      "for(const method of ['writeFile','appendFile','mkdir','unlink','rename','rm']) fs.promises[method]=trap('fs.promises.'+method);",
      'const open=fs.openSync; fs.openSync=(filename,flags,...rest)=>{',
      "if(typeof flags!=='number'||(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))) return trap('open-write')();",
      'return open(filename,flags,...rest);};',
      "globalThis.fetch=trap('fetch');syncBuiltinESMExports();",
      'const result=validateEvidence({manifestPath:process.argv[2],reportPath:process.argv[3],evidenceRoot:process.argv[4]});',
      'process.stdout.write(JSON.stringify({result,calls}));',
    ].join('\n');
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, cli, manifestPath, reportPath, evidenceRoot],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    const output = JSON.parse(child.stdout);
    expect(output.calls).toEqual([]);
    expect(output.result.validationStatus).toBe('report_valid');
  });
  it('V03 actually reads at most limit+1, including a growing-file observation', () => {
    persist(manifestPath, manifest);
    const script = [
      "import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {pathToFileURL} from 'node:url';",
      "const modulePath=process.argv[1];process.argv[1]='aq01-harness';const {validateEvidence}=await import(pathToFileURL(modulePath).href);",
      'const open=fs.openSync,read=fs.readSync;let target;let count=0;',
      'fs.openSync=(file,...args)=>{const fd=open(file,...args);if(file===process.argv[2])target=fd;return fd;};',
      'fs.readSync=(fd,buffer,offset,length,position)=>{if(fd!==target)return read(fd,buffer,offset,length,position);buffer.fill(32,offset,offset+length);count+=length;return length;};',
      'syncBuiltinESMExports();',
      'process.stdout.write(JSON.stringify({result:validateEvidence({manifestPath:process.argv[2]}),count}));',
    ].join('\n');
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, cli, manifestPath],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(child.status).toBe(0);
    const output = JSON.parse(child.stdout);
    invalid(output.result, 'INPUT_LIMIT');
    expect(output.count).toBe(1024 * 1024 + 1);
  });
  it('V21 detects root identity drift during a read', () => {
    const r = runtimeShapedReport();
    persist(manifestPath, manifest);
    persist(reportPath, r);
    const script = [
      "import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {pathToFileURL} from 'node:url';",
      "const modulePath=process.argv[1];process.argv[1]='aq01-harness';const {validateEvidence}=await import(pathToFileURL(modulePath).href);",
      'const stat=fs.lstatSync;let reads=0;',
      'fs.lstatSync=(file,...args)=>{const result=stat(file,...args);if(file===process.argv[4]&&++reads>1)result.ino+=1;return result;};',
      'syncBuiltinESMExports();',
      'process.stdout.write(JSON.stringify(validateEvidence({manifestPath:process.argv[2],reportPath:process.argv[3],evidenceRoot:process.argv[4]})));',
    ].join('\n');
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, cli, manifestPath, reportPath, evidenceRoot],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(child.status).toBe(0);
    invalid(JSON.parse(child.stdout), 'EVIDENCE_INVALID');
  });
});

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin/ci/validate-cpa-v8-evidence.mjs');
const seedFile = path.join(repo, 'tests/fixtures/cpa-v8-qualification/manifest.json');
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const secret = 'AQ01_PRIVATE_SENTINEL_DO_NOT_PRINT';
let root, manifestPath, reportPath, evidenceRoot, manifest;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cpamp-aq01-test-')));
  evidenceRoot = path.join(root, 'evidence');
  mkdirSync(evidenceRoot, { mode: 0o700 });
  manifestPath = path.join(root, 'manifest.json');
  reportPath = path.join(root, 'report.json');
  // Preserve all historical r1 contract tests after the checked-in scope moves to r2.
  manifest = createSeedManifest();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const persist = (filename, value) => writeFileSync(filename, encode(value), { mode: 0o600 });
const check = (report) => {
  persist(manifestPath, manifest);
  if (report) {
    persist(reportPath, report);
    return validateEvidence({ manifestPath, reportPath, evidenceRoot });
  }
  return validateEvidence({ manifestPath });
};
const invalid = (result, errorCode) =>
  expect(result).toEqual({ validationStatus: 'invalid', errorCode });
const seedCase = (id) => manifest.cases.find((c) => c.operationRef === id);
const cliRun = (args, env = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ...env },
  });
function notRunReport(caseIds = [seedCase('AUTH-01').id, seedCase('CFG-01').id]) {
  const selectedCases = manifest.cases.filter((c) => caseIds.includes(c.id));
  const fixtureRefs = [...new Set(selectedCases.map((c) => c.fixtureRef))];
  return {
    schemaVersion: 1,
    contractId: 'cpamp-cpa-v8-qualification',
    manifestRevision: 'r1',
    manifestSha256: sha(encode(manifest)),
    run: {
      id: 'AQ01-FORMAT-EXAMPLE',
      kind: 'foundation-fixture',
      runnerCommit: null,
      state: 'not_run',
      selectedCaseRefs: caseIds,
      startedAt: null,
      endedAt: null,
      setupState: 'not_run',
      cleanupState: 'not_run',
      fixtureInputRefs: fixtureRefs.map((fixtureRef) => {
        const f = manifest.fixtures.find((item) => item.id === fixtureRef);
        return {
          fixtureRef,
          revision: f.revision,
          configProfileId: f.configProfileId,
          modeProfileId: f.modeProfileId,
        };
      }),
    },
    artifactObservation: {
      candidateRef: manifest.candidate.id,
      provenance: 'not-verified',
      observedArchiveSha256: null,
      observedBinarySha256: null,
    },
    results: selectedCases.map((c) => ({
      caseRef: c.id,
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
function traceFor(report, result) {
  return {
    schemaVersion: 1,
    runId: report.run.id,
    caseRef: result.caseRef,
    records: result.assertions
      .filter((a) => a.outcome !== 'not_run')
      .map((a) => ({
        ...a,
        httpStatus: 200,
        elapsedMs: 5,
        requestBytes: 0,
        responseBytes: 20,
      })),
  };
}
function saveTrace(report, trace, relativePath = 'trace.json') {
  const bytes = encode(trace);
  writeFileSync(path.join(evidenceRoot, relativePath), bytes, { mode: 0o600 });
  const evidence = report.evidence.find((e) => e.relativePath === relativePath);
  if (evidence) evidence.sha256 = sha(bytes);
}
function runtimeShapedReport(operation = 'AUTH-01') {
  // Synthetic format data only: no CPA process, network or provider call.
  const c = seedCase(operation);
  const r = notRunReport([c.id]);
  Object.assign(r.run, {
    kind: 'upstream-run',
    state: 'completed',
    runnerCommit: 'a'.repeat(40),
    startedAt: '2026-10-06T00:00:00.000Z',
    endedAt: '2026-10-06T00:00:01.000Z',
    setupState: 'ready',
    cleanupState: 'completed',
  });
  Object.assign(r.artifactObservation, {
    provenance: 'locally-verified',
    observedArchiveSha256: manifest.candidate.declaredSha256,
    observedBinarySha256: 'b'.repeat(64),
  });
  Object.assign(r.results[0], {
    executionState: 'completed',
    assertionOutcome: 'pass',
    capability: 'supported',
    reasonCode: 'NONE',
    assertions: c.expectations.map((e) => ({
      expectationRef: e.id,
      outcome: 'pass',
      observationCode: 'EXPECTED_MATCH',
    })),
    evidenceRefs: ['TRACE-1'],
  });
  r.evidence = [{ id: 'TRACE-1', kind: 'sanitized-trace', relativePath: 'trace.json', sha256: '' }];
  saveTrace(r, traceFor(r, r.results[0]));
  return r;
}
describe('AQ-01 format foundation', () => {
  it.each(['pass', 'fail', 'error', 'not_run'])(
    'preserves optional assertion outcome %s without rejecting mandatory success',
    (outcome) => {
      seedCase('AUTH-01').expectations.push({
        id: 'OPTIONAL-OBSERVATION',
        mandatory: false,
        checkCode: 'BODY_SHAPE',
      });
      const r = runtimeShapedReport();
      Object.assign(r.results[0].assertions[1], {
        outcome,
        observationCode: outcome === 'not_run' ? 'NONE' : 'EFFECT_UNKNOWN',
      });
      saveTrace(r, traceFor(r, r.results[0]));
      expect(check(r)).toMatchObject({
        validationStatus: 'report_valid',
        completed: 1,
        requiredPending: 13,
      });
    }
  );
  it.each([
    'NOT_RUN',
    'NOT_IMPLEMENTED',
    'OPTIONAL_DISABLED',
    'SETUP_FAILED',
    'TIMEOUT',
    'CANCELLED',
    'INPUT_LIMIT',
    'TARGET_UNREACHABLE',
    'CLEANUP_FAILED',
  ])('rejects completed results with nonexecution reason %s', (reasonCode) => {
    const r = runtimeShapedReport();
    Object.assign(r.results[0], { reasonCode, capability: 'unknown' });
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it('does not allow skipped assertions to invent observations or execution traces', () => {
    seedCase('AUTH-01').expectations.push({
      id: 'OPTIONAL-OBSERVATION',
      mandatory: false,
      checkCode: 'BODY_SHAPE',
    });
    const r = runtimeShapedReport();
    Object.assign(r.results[0].assertions[1], {
      outcome: 'not_run',
      observationCode: 'EXPECTED_MATCH',
    });
    invalid(check(r), 'RESULT_STATE_INVALID');
    r.results[0].assertions[1].observationCode = 'NONE';
    const trace = traceFor(r, r.results[0]);
    trace.records.push({
      ...r.results[0].assertions[1],
      httpStatus: null,
      elapsedMs: 0,
      requestBytes: 0,
      responseBytes: 0,
    });
    saveTrace(r, trace);
    invalid(check(r), 'EVIDENCE_INVALID');
  });
  it('declares 16 operations and seven profiles without execution', () => {
    expect(manifest.operations.map((op) => op.id)).toEqual([
      'AUTH-01',
      'AUTH-02',
      'CFG-01',
      'CFG-02',
      'KEY-01',
      'KEY-02',
      'CRED-01',
      'CRED-02',
      'OAUTH-01',
      'MODEL-01',
      'USAGE-01',
      'USAGE-02',
      'STAGE-01',
      'EXT-GUARD-01',
      'PLUGIN-CORE-01',
      'EXT-ENABLE-01',
    ]);
    expect(manifest.profiles.filter((p) => p.selected).map((p) => p.id)).toEqual([
      'CPA8-MGMT-MIN-r1',
      'CPA8-USAGE-MIN-r1',
      'CPA8-STAGE-r1',
      'CPA8-EXTERNAL-SAFETY-r1',
      'CPA8-EXTENSION-GUARD-r1',
    ]);
    expect(manifest.profiles.filter((p) => !p.selected).map((p) => p.id)).toEqual([
      'CPA8-PLUGIN-CORE-r1',
      'CPA8-EXTENSION-ENABLE-r1',
    ]);
    expect(manifest.operations.find((op) => op.id === 'EXT-ENABLE-01').surfaces).toEqual([]);
    expect(check()).toEqual({
      validationStatus: 'manifest_valid',
      declared: 16,
      selected: 0,
      completed: 0,
      pending: 16,
      requiredPending: 14,
      setupFailures: 0,
      cleanupFailures: 0,
    });
  });
  it('accepts not-run foundation data while preserving pending', () => {
    expect(check(notRunReport())).toMatchObject({
      validationStatus: 'report_valid',
      selected: 2,
      completed: 0,
      pending: 16,
      requiredPending: 14,
    });
  });
  it('preserves partial results, required gaps and cleanup failure', () => {
    const r = runtimeShapedReport();
    r.run.state = 'aborted';
    r.run.cleanupState = 'failed';
    const missing = notRunReport().results[1];
    r.run.selectedCaseRefs.push(missing.caseRef);
    r.results.push(missing);
    expect(check(r)).toMatchObject({
      validationStatus: 'report_valid',
      selected: 2,
      completed: 1,
      pending: 15,
      requiredPending: 13,
      cleanupFailures: 1,
    });
  });
  it('records failed assertions as executed failures', () => {
    const r = runtimeShapedReport();
    Object.assign(r.results[0], {
      assertionOutcome: 'fail',
      capability: 'unknown',
      reasonCode: 'ASSERTION_FAILED',
    });
    Object.assign(r.results[0].assertions[0], {
      outcome: 'fail',
      observationCode: 'EXPECTED_MISMATCH',
    });
    saveTrace(r, traceFor(r, r.results[0]));
    expect(check(r)).toMatchObject({
      validationStatus: 'report_valid',
      completed: 1,
      requiredPending: 14,
    });
  });
  it('accepts guard foundation proof without supporting upstream functions', () => {
    const r = runtimeShapedReport('EXT-GUARD-01');
    r.run.kind = 'foundation-fixture';
    Object.assign(r.artifactObservation, {
      provenance: 'not-verified',
      observedArchiveSha256: null,
      observedBinarySha256: null,
    });
    expect(check(r)).toMatchObject({ validationStatus: 'report_valid', requiredPending: 13 });
  });
  it('records setup failure without guessing unsupported', () => {
    const r = notRunReport();
    Object.assign(r.run, {
      kind: 'upstream-run',
      state: 'aborted',
      runnerCommit: 'a'.repeat(40),
      setupState: 'failed',
      cleanupState: 'completed',
      startedAt: '2026-10-06T00:00:00.000Z',
      endedAt: '2026-10-06T00:00:01.000Z',
    });
    expect(check(r)).toMatchObject({
      validationStatus: 'report_valid',
      setupFailures: 1,
      requiredPending: 14,
    });
  });
});
describe('V-AQ01-01 through 07: canonical input and references', () => {
  it.each([
    ['malformed', Buffer.from('{"token":"' + secret + '",')],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0xfd])],
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}\n')])],
  ])('V01 rejects %s without fragments', (_, bytes) => {
    writeFileSync(manifestPath, bytes);
    const child = cliRun(['--manifest', manifestPath]);
    expect(child.status).toBe(1);
    invalid(JSON.parse(child.stdout), 'INPUT_INVALID');
    expect(child.stderr).toBe('');
    expect(child.stdout).not.toContain(secret);
  });
  it.each([
    [
      'duplicate',
      (s) => s.replace('  "schemaVersion": 1,', '  "schemaVersion": 9,\n  "schemaVersion": 1,'),
    ],
    ['exponent', (s) => s.replace('"schemaVersion": 1', '"schemaVersion": 1e0')],
    ['negative zero', (s) => s.replace('"schemaVersion": 1', '"schemaVersion": -0')],
    ['unsafe integer', (s) => s.replace('"schemaVersion": 1', '"schemaVersion": 9007199254740993')],
    ['compact', () => JSON.stringify(manifest)],
    ['extra newline', (s) => s + '\n'],
  ])('V02 rejects %s', (_, change) => {
    writeFileSync(manifestPath, change(encode(manifest).toString()));
    invalid(validateEvidence({ manifestPath }), 'NON_CANONICAL');
  });
  it('V03 bounds manifest bytes at limit+1', () => {
    writeFileSync(manifestPath, Buffer.alloc(1024 * 1024 + 1, 32));
    invalid(validateEvidence({ manifestPath }), 'INPUT_LIMIT');
  });
  it('V03 bounds report bytes independently', () => {
    persist(manifestPath, manifest);
    writeFileSync(reportPath, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    invalid(validateEvidence({ manifestPath, reportPath, evidenceRoot }), 'INPUT_LIMIT');
  });
  it('V03 bounds structural depth before walking fields', () => {
    let nested = {};
    for (let i = 0; i < 18; i++) nested = { child: nested };
    manifest.extra = nested;
    invalid(check(), 'INPUT_LIMIT');
  });
  it('V03 bounds cases and expectations', () => {
    const original = structuredClone(manifest);
    manifest.cases = Array.from({ length: 257 }, () => manifest.cases[0]);
    invalid(check(), 'INPUT_LIMIT');
    manifest = original;
    manifest.cases[0].expectations = Array.from(
      { length: 33 },
      () => manifest.cases[0].expectations[0]
    );
    invalid(check(), 'INPUT_LIMIT');
  });
  it.each(['raw_body', 'config', 'authorization', '__proto__', 'constructor'])(
    'V04 rejects field %s',
    (field) => {
      Object.defineProperty(manifest.candidate, field, { value: secret, enumerable: true });
      invalid(check(), 'FIELD_REJECTED');
    }
  );
  it.each([
    (m) => {
      m.schemaVersion = 2;
    },
    (m) => {
      m.revision = 'r5';
    },
    (m) => {
      m.contractId = 'other';
    },
  ])('V05 rejects unknown schema', (change) => {
    change(manifest);
    invalid(check(), 'SCHEMA_VERSION');
  });
  it.each(['operations', 'profiles', 'fixtures', 'cases'])('V06 rejects duplicate %s', (key) => {
    manifest[key].push(structuredClone(manifest[key][0]));
    invalid(check(), 'ID_OR_REF_INVALID');
  });
  it('V06 rejects duplicate expectations across cases', () => {
    manifest.cases[1].expectations[0].id = manifest.cases[0].expectations[0].id;
    invalid(check(), 'ID_OR_REF_INVALID');
  });
  it.each([
    (m) => {
      m.cases[0].operationRef = 'UNKNOWN';
    },
    (m) => {
      m.cases[0].profileRefs.push(m.cases[0].profileRefs[0]);
    },
    (m) => {
      m.cases[0].surfaceRefs = ['CFG-02-S1'];
    },
    (m) => {
      m.operations[0].id = 'UNKNOWN';
    },
  ])('V07 rejects dangling, repeated or foreign refs', (change) => {
    change(manifest);
    invalid(check(), 'ID_OR_REF_INVALID');
  });
});
describe('V-AQ01-08 through 14: binding, coverage and surfaces', () => {
  it.each([
    (m) => {
      m.cpampBaselineCommit = 'c'.repeat(40);
    },
    (m) => {
      m.planInput.gateBlobSha = 'c'.repeat(40);
    },
    (m) => {
      m.candidate.variant = 'no-plugin';
    },
    (m) => {
      m.candidate.sourceCommit = 'c'.repeat(40);
    },
    (m) => {
      m.candidate.declaredSha256 = 'c'.repeat(64);
    },
    (m) => {
      m.fixtures[0].revision = 'r2';
    },
    (m) => {
      m.fixtures[0].configProfileId = 'other';
    },
    (m) => {
      m.fixtures[0].modeProfileId = 'remote';
    },
  ])('V08 rejects mixed manifest identity', (change) => {
    change(manifest);
    invalid(check(), 'ARTIFACT_BINDING_INVALID');
  });
  it.each([
    (r) => {
      r.manifestSha256 = 'c'.repeat(64);
    },
    (r) => {
      r.run.fixtureInputRefs[0].revision = 'r2';
    },
    (r) => {
      r.run.fixtureInputRefs[0].configProfileId = 'other';
    },
    (r) => {
      r.run.fixtureInputRefs[0].modeProfileId = 'other';
    },
    (r) => {
      r.artifactObservation.candidateRef = 'other';
    },
  ])('V08 rejects report binding drift', (change) => {
    const r = notRunReport();
    change(r);
    invalid(check(r), 'ARTIFACT_BINDING_INVALID');
  });
  it.each([
    (m) => {
      m.profiles[0].selected = false;
    },
    (m) => {
      m.profiles[0].optionalOperationRefs.push(m.profiles[0].requiredOperationRefs.pop());
    },
    (m) => {
      m.cases = m.cases.filter((c) => c.operationRef !== 'CFG-02');
    },
    () => {
      seedCase('CFG-02').expectations[0].mandatory = false;
    },
    (m) => {
      m.profiles.pop();
    },
    (m) => {
      m.profiles[6].selected = true;
    },
  ])('V09 rejects weakened required composition or optional enable', (change) => {
    change(manifest);
    invalid(check(), 'COVERAGE_INVALID');
  });
  it.each([
    (m) => {
      m.operations.find((o) => o.id === 'CFG-02').surfaces[0].effect = 'read-only';
    },
    (m) => {
      m.operations.find((o) => o.id === 'CRED-02').surfaces[0].method = 'GET';
    },
    (m) => {
      m.operations.find((o) => o.id === 'OAUTH-01').surfaces[1].pathTemplate =
        '/v8/management/oauth/lookup';
    },
  ])('V10 rejects misclassified or invented composite surfaces', (change) => {
    change(manifest);
    invalid(check(), 'SURFACE_POLICY_INVALID');
  });
  it.each(['USAGE-02', 'OAUTH-01'])('V11 GET %s is never probe safe', (op) => {
    manifest.operations.find((o) => o.id === op).surfaces[0].probeEligible = true;
    invalid(check(), 'SURFACE_POLICY_INVALID');
  });
  it.each(['management', 'fixture-only', 'client-key'])(
    'V12 preserves callback authority against %s',
    (authClass) => {
      manifest.operations.find((o) => o.id === 'OAUTH-01').surfaces[2].authClass = authClass;
      invalid(check(), 'SURFACE_POLICY_INVALID');
    }
  );
  it.each([
    '/v0/management/config',
    '/v8/management/*',
    'https://example.invalid/config',
    '/v8/management/../config',
  ])('V13 rejects %s', (route) => {
    manifest.operations[0].surfaces[0].pathTemplate = route;
    invalid(check(), 'SURFACE_POLICY_INVALID');
  });
  it('V13 rejects fabricated extension registration', () => {
    manifest.operations.at(-1).surfaces.push({
      ...manifest.operations[0].surfaces[0],
      id: 'FAKE-EXT',
      ownerClass: 'declared-extension',
    });
    seedCase('EXT-ENABLE-01').surfaceRefs = ['FAKE-EXT'];
    invalid(check(), 'SURFACE_POLICY_INVALID');
  });
  it.each([
    (r) => {
      r.artifactObservation.provenance = 'locally-verified';
    },
    (r) => {
      r.artifactObservation.observedBinarySha256 = 'd'.repeat(64);
    },
    (r) => {
      r.artifactObservation.provenance = 'source-build';
    },
  ])('V14 rejects unverified hashes/provenance', (change) => {
    const r = notRunReport();
    change(r);
    invalid(check(r), 'ARTIFACT_BINDING_INVALID');
  });
  it('V14 rejects observed archive mismatch', () => {
    const r = runtimeShapedReport();
    r.artifactObservation.observedArchiveSha256 = 'd'.repeat(64);
    invalid(check(r), 'ARTIFACT_BINDING_INVALID');
  });
});
describe('V-AQ01-15 through 20: state truthfulness', () => {
  it('V15 rejects foundation claiming verified artifact', () => {
    const r = runtimeShapedReport();
    r.run.kind = 'foundation-fixture';
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it('V15 rejects supported local stub function', () => {
    Object.assign(seedCase('AUTH-01'), {
      fixtureRef: 'CPA8-HARNESS-r1',
      proofScope: 'harness-behavior',
    });
    invalid(check(runtimeShapedReport()), 'RESULT_STATE_INVALID');
  });
  it('V15 rejects support without verified artifact', () => {
    const r = runtimeShapedReport();
    Object.assign(r.artifactObservation, {
      provenance: 'not-verified',
      observedArchiveSha256: null,
      observedBinarySha256: null,
    });
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it.each([
    (r) => {
      r.results[0].capability = 'supported';
    },
    (r) => {
      r.results[0].assertionOutcome = 'pass';
    },
    (r) => {
      r.results[0].executionState = 'skip';
    },
    (r) => {
      r.results[0].reasonCode = 'TIMEOUT';
    },
  ])('V16 rejects not-run/skip/timeout false pass', (change) => {
    const r = notRunReport();
    change(r);
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it('V16 rejects supported aborted result', () => {
    const r = runtimeShapedReport();
    r.run.state = 'aborted';
    Object.assign(r.results[0], {
      executionState: 'aborted',
      assertionOutcome: 'error',
      reasonCode: 'TIMEOUT',
    });
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it.each([
    (r) => {
      r.results[0].assertions = [];
    },
    (r) => {
      r.results[0].assertions[0].outcome = 'fail';
    },
  ])('V17 requires mandatory assertions', (change) => {
    const r = runtimeShapedReport();
    change(r);
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it('V18 prevents guard proof supporting function', () => {
    Object.assign(seedCase('AUTH-01'), {
      fixtureRef: 'CPA8-GUARD-r1',
      proofScope: 'boundary-guard',
    });
    invalid(check(runtimeShapedReport()), 'RESULT_STATE_INVALID');
  });
  it('V19 requires every selected result', () => {
    const r = notRunReport();
    r.results.pop();
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it('V19 rejects completed run with not-run result', () => {
    const r = runtimeShapedReport(),
      c = notRunReport().results[1];
    r.run.selectedCaseRefs.push(c.caseRef);
    r.results.push(c);
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it('V20 rejects duplicate result/evidence IDs', () => {
    const r = notRunReport();
    r.results.push(structuredClone(r.results[0]));
    invalid(check(r), 'ID_OR_REF_INVALID');
    const e = runtimeShapedReport();
    e.evidence.push(structuredClone(e.evidence[0]));
    invalid(check(e), 'ID_OR_REF_INVALID');
  });
  it('V20 rejects unselected results', () => {
    const r = notRunReport();
    r.results[0].caseRef = seedCase('CFG-02').id;
    invalid(check(r), 'ID_OR_REF_INVALID');
  });
  it.each([
    (r) => {
      r.run.endedAt = '2026-10-05T23:59:59.000Z';
    },
    (r) => {
      r.run.startedAt = '2026-02-30T00:00:00.000Z';
    },
    (r) => {
      r.run.runnerCommit = null;
    },
    (r) => {
      r.run.cleanupState = 'failed';
    },
    (r) => {
      r.run.setupState = 'failed';
    },
  ])('V20 rejects inconsistent run metadata', (change) => {
    const r = runtimeShapedReport();
    change(r);
    invalid(check(r), 'RESULT_STATE_INVALID');
  });
  it('V20 cannot execute disabled optional extension', () =>
    invalid(check(runtimeShapedReport('EXT-ENABLE-01')), 'RESULT_STATE_INVALID'));
});
describe('V-AQ01-21 through 24: evidence, privacy and tools', () => {
  it.each([
    '/etc/passwd',
    '../outside.json',
    'a/../../outside.json',
    'https://example.invalid/t',
    '%2e%2e/t',
    'dir\\trace.json',
    'a//t',
    './trace.json',
  ])('V21 rejects %s', (relativePath) => {
    const r = runtimeShapedReport();
    r.evidence[0].relativePath = relativePath;
    invalid(check(r), 'EVIDENCE_INVALID');
  });
  it('V21 rejects external symlink file', () => {
    const r = runtimeShapedReport(),
      outside = path.join(root, 'outside.json');
    writeFileSync(outside, secret);
    rmSync(path.join(evidenceRoot, 'trace.json'));
    symlinkSync(outside, path.join(evidenceRoot, 'trace.json'));
    invalid(check(r), 'EVIDENCE_INVALID');
    expect(readFileSync(outside, 'utf8')).toBe(secret);
  });
  it('V21 rejects symlink roots and intermediate directories', () => {
    const r = runtimeShapedReport(),
      link = path.join(root, 'root-link');
    symlinkSync(evidenceRoot, link);
    persist(manifestPath, manifest);
    persist(reportPath, r);
    invalid(validateEvidence({ manifestPath, reportPath, evidenceRoot: link }), 'EVIDENCE_INVALID');
    symlinkSync(root, path.join(evidenceRoot, 'escape'));
    r.evidence[0].relativePath = 'escape/report.json';
    invalid(check(r), 'EVIDENCE_INVALID');
  });
  it('V21 requires owned immutable directory permissions', () => {
    const r = runtimeShapedReport();
    chmodSync(evidenceRoot, 0o777);
    invalid(check(r), 'EVIDENCE_INVALID');
  });
  it('V22 rejects missing trace and bad hash', () => {
    const r = runtimeShapedReport();
    r.evidence[0].sha256 = 'd'.repeat(64);
    invalid(check(r), 'EVIDENCE_INVALID');
    rmSync(path.join(evidenceRoot, 'trace.json'));
    invalid(check(r), 'EVIDENCE_INVALID');
  });
  it('V22 bounds trace bytes', () => {
    const r = runtimeShapedReport();
    writeFileSync(path.join(evidenceRoot, 'trace.json'), Buffer.alloc(1024 * 1024 + 1));
    invalid(check(r), 'INPUT_LIMIT');
  });
  it.each([
    (t) => {
      t.runId = 'FOREIGN-RUN';
    },
    (t) => {
      t.caseRef = 'FOREIGN-CASE';
    },
    (t) => {
      t.records[0].expectationRef = 'FOREIGN-EXPECTATION';
    },
    (t) => {
      t.records[0].httpStatus = 600;
    },
    (t) => {
      t.records[0].body = secret;
    },
    (t) => {
      t.records = [];
    },
  ])('V22 binds trace and rejects empty or raw evidence', (change) => {
    const r = runtimeShapedReport(),
      t = traceFor(r, r.results[0]);
    change(t);
    saveTrace(r, t);
    invalid(check(r), 'EVIDENCE_INVALID');
  });
  it('V22 bounds record count and rejects duplicates', () => {
    const r = runtimeShapedReport(),
      t = traceFor(r, r.results[0]);
    t.records.push(structuredClone(t.records[0]));
    saveTrace(r, t);
    invalid(check(r), 'EVIDENCE_INVALID');
    t.records = Array.from({ length: 33 }, () => t.records[0]);
    saveTrace(r, t);
    invalid(check(r), 'INPUT_LIMIT');
  });
  it.each(['reasonCode', 'observationCode'])('V23 refuses raw secret in %s', (field) => {
    const r = runtimeShapedReport();
    if (field === 'reasonCode') r.results[0][field] = secret;
    else r.results[0].assertions[0][field] = secret;
    persist(manifestPath, manifest);
    persist(reportPath, r);
    const child = cliRun([
      '--manifest',
      manifestPath,
      '--report',
      reportPath,
      '--evidence-root',
      evidenceRoot,
    ]);
    expect(child.status).toBe(1);
    invalid(JSON.parse(child.stdout), 'PRIVACY_REJECTED');
    expect(child.stdout + child.stderr).not.toContain(secret);
  });
  it('V23 never echoes input-supplied valid IDs', () => {
    const r = notRunReport();
    r.run.id = secret;
    expect(check(r).validationStatus).toBe('report_valid');
    expect(JSON.stringify(check(r))).not.toContain(secret);
  });
  it.each([
    ['--execute'],
    ['--url', 'https://example.invalid'],
    ['--key', secret],
    ['--manifest'],
    ['--manifest', 'one', '--manifest', 'two'],
    ['--report', 'r'],
    ['--manifest', 'm', '--evidence-root', 'e'],
  ])('V24 rejects CLI argv %j before reading', (...args) => {
    const child = cliRun(args);
    expect(child.status).toBe(2);
    invalid(JSON.parse(child.stdout), 'USAGE');
    expect(child.stderr).toBe('');
    expect(child.stdout).not.toContain(secret);
  });
  it('V24 rejects injected execution dependencies', () => {
    let called = false;
    invalid(
      validateEvidence({
        manifestPath,
        execute: () => {
          called = true;
        },
      }),
      'SIDE_EFFECT_REJECTED'
    );
    expect(called).toBe(false);
  });
  it('V24 ignores credential env and emits one safe JSON', () => {
    persist(manifestPath, manifest);
    const child = cliRun(['--manifest', manifestPath], {
      CPA_MANAGEMENT_KEY: secret,
      CPA_BASE_URL: 'https://example.invalid',
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(child.stdout).validationStatus).toBe('manifest_valid');
    expect(child.stdout).not.toContain(secret);
  });
});
