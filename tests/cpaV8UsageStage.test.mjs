import {
  chmodSync,
  existsSync,
  linkSync,
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
import { afterEach, describe, expect, it } from 'vitest';
import {
  createUsageStageManifest,
  createExternalManifest,
  createManagementManifest,
  createSeedManifest,
  validateEvidence,
} from '../bin/ci/validate-cpa-v8-evidence.mjs';
import { selectCases, fixtureConfig, boundedRequest } from '../bin/ci/run-cpa-v8-qualification.mjs';
import {
  captureThenDrop,
  parseResp,
  projectReceipts,
  respCommand,
  usageBudget,
} from '../bin/ci/cpa-v8-usage-fixtures.mjs';
import { createStage, stageTree, legacyConfig } from '../bin/ci/cpa-v8-stage-fixtures.mjs';

const roots = [];
function temp() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aq04-test-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function stageFixture() {
  const root = temp(),
    f = { root, child: { alive: false, stopped: true } };
  const config = fixtureConfig({
    port: 1234,
    stubPort: 4321,
    authDir: '/unused',
    managementKey: 'fixture-management',
    clientKey: 'fixture-client',
    upstreamKey: 'fixture-upstream',
  });
  const s = createStage(f, legacyConfig(config, 'fixture-management'));
  return { f, s };
}
function commit(s) {
  const before = s.bytes();
  writeFileSync(path.join(s.candidate, 'config.yaml'), 'committed: true\n');
  expect(s.observeCommit(before)).toBe(true);
}

describe('AQ-04 frozen scope and limits', () => {
  it('V-AQ04-01 preserves historical factories and selects 34 groups in r4 only', () => {
    const m = createUsageStageManifest(),
      selected = selectCases(m, 'usage-stage-r4');
    expect(selected).toHaveLength(40);
    expect(new Set(selected.map((c) => c.id.split('-')[1])).size).toBe(34);
    expect(m.operations).toHaveLength(16);
    expect(m.profiles).toHaveLength(7);
    expect(m.cases.filter((c) => c.id.startsWith('AQ04-P'))).toHaveLength(2);
    for (const old of [
      createSeedManifest(),
      createManagementManifest(),
      createExternalManifest(),
    ]) {
      expect(() => selectCases(old, 'usage-stage-r4')).toThrow();
      expect(old.cases.some((c) => c.id.startsWith('AQ04-'))).toBe(false);
    }
    expect(selected.every((c) => c.budgetRef === 'standard-r1')).toBe(true);
  });
  it.each(['case', 'required', 'proof', 'budget', 'composition'])(
    'V-AQ04-02/05 rejects %s drift',
    (kind) => {
      const m = createUsageStageManifest();
      const leaf = m.cases.find((c) => c.id === 'AQ04-U09-relay');
      if (kind === 'case') m.cases.pop();
      if (kind === 'required') leaf.expectations[0].mandatory = false;
      if (kind === 'proof') leaf.proofScope = 'upstream-function';
      if (kind === 'budget') leaf.budgetRef = 'oauth-expiry-r2';
      if (kind === 'composition') m.profiles[0].requiredOperationRefs.pop();
      const file = path.join(temp(), 'manifest.json');
      writeFileSync(file, JSON.stringify(m));
      expect(validateEvidence({ manifestPath: file }).validationStatus).toBe('invalid');
    }
  );
  it('V-AQ04-03 requires complete upstream receipt before dropping the downstream response', async () => {
    const events = [];
    const captured = await captureThenDrop({ loopbackRequest: boundedRequest }, async () => {
      await new Promise((r) => setTimeout(r, 15));
      events.push('complete');
      return [{ private: true }];
    });
    events.push('downstream-failed');
    expect(events).toEqual(['complete', 'downstream-failed']);
    expect(captured).toHaveLength(1);
    await expect(
      captureThenDrop({ loopbackRequest: boundedRequest }, async () => [])
    ).rejects.toThrow('SETUP_FAILED');
    await expect(
      captureThenDrop({ loopbackRequest: boundedRequest }, async () => {
        throw Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' });
      })
    ).rejects.toThrow('TIMEOUT');
  });
  it('V-AQ04-04/06 empty, duplicate and stale receipts never fill gaps or export private IDs', () => {
    const binding = {};
    const projected = projectReceipts(['private-id', 'private-id'], binding, binding, true);
    expect(projected).toEqual({
      received: 2,
      unique: 1,
      duplicates: 1,
      coverage: 'receipt-only',
      gap: 'unknown',
      replay: 'unproven',
    });
    expect(JSON.stringify(projected)).not.toContain('private-id');
    expect(projectReceipts([], binding, binding).coverage).toBe('unknown');
    expect(projectReceipts(['private-id'], binding, {}, true).gap).toBe('unknown');
  });
  it.each([
    ['FLUSHALL'],
    ['SUBSCRIBE', 'other'],
    ['LPOP', 'usage', '17'],
    ['AUTH'],
    ['PING', 'extra'],
  ])('V-AQ04-07 rejects RESP %j', (...parts) => {
    expect(() => respCommand(parts)).toThrow('INPUT_LIMIT');
  });
  it('V-AQ04-07 bounds fragmented and malformed frames', () => {
    expect(parseResp(Buffer.from('$5\r\nabc'))).toBe(null);
    expect(parseResp(Buffer.from('*2\r\n+OK\r\n:1\r\n')).value).toEqual(['OK', 1]);
    for (const input of ['$1048577\r\n', '*17\r\n', '$-2\r\n', '$3\r\nabcXX', '!bad\r\n'])
      expect(() => parseResp(Buffer.from(input))).toThrow('INPUT_LIMIT');
  });
  it('V-AQ04-08 enforces per-pop, request, record, producer and byte bounds', () => {
    expect(() => usageBudget().pop(17)).toThrow('INPUT_LIMIT');
    const b = usageBudget();
    for (let i = 0; i < 32; i++) b.pop(16);
    expect(() => b.pop()).toThrow('INPUT_LIMIT');
    expect(() => usageBudget().receive(Array(513).fill({}))).toThrow('INPUT_LIMIT');
    expect(() => usageBudget(true).produce(1025)).toThrow('INPUT_LIMIT');
    expect(() => usageBudget(true).receive(['x'.repeat(32 * 1024 * 1024)])).toThrow('INPUT_LIMIT');
  });
});

describe('AQ-04 source and restore boundaries', () => {
  it.each(['symlink', 'hardlink', 'oversize'])('V-AQ04-09/10 rejects %s members', (kind) => {
    const root = temp(),
      source = path.join(root, 'tree');
    mkdirSync(source, { mode: 0o700 });
    const file = path.join(source, 'a');
    writeFileSync(file, 'x', { mode: 0o600 });
    if (kind === 'symlink') symlinkSync(file, path.join(source, 'b'));
    if (kind === 'hardlink') linkSync(file, path.join(source, 'b'));
    if (kind === 'oversize') writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
    expect(() => stageTree(source)).toThrow();
  });
  it('V-AQ04-10 rejects too many members and includes modes and absence in the snapshot', () => {
    const { s } = stageFixture();
    try {
      expect(existsSync(path.join(s.source, 'auth'))).toBe(false);
      expect(stageTree(s.source).entries.every((e) => !(e.mode & 0o222))).toBe(true);
      for (let i = 0; i < 64; i++)
        writeFileSync(path.join(s.candidate, 'member-' + i), '', { mode: 0o600 });
      expect(() => s.tree()).toThrow('INPUT_LIMIT');
      for (let i = 0; i < 64; i++) rmSync(path.join(s.candidate, 'member-' + i));
    } finally {
      s.cleanupModes();
    }
  });
  it('V-AQ04-11 rebinds only candidate paths and rejects reused/overlapping targets', () => {
    const { f, s } = stageFixture();
    try {
      expect(s.bytes().toString()).toContain(path.join(s.candidate, 'auth'));
      expect(s.bytes().toString()).not.toContain(s.source);
      expect(() => createStage(f, {})).toThrow();
      s.sourceUnchanged();
    } finally {
      s.cleanupModes();
    }
  });
  it('V-AQ04-12 refuses commit-unknown and prevents precommit discard after observed writes', () => {
    const { s } = stageFixture();
    try {
      commit(s);
      expect(() => s.discardPrecommit()).toThrow();
      expect(() => s.restore(s.checkpoint(false))).toThrow();
    } finally {
      s.cleanupModes();
    }
  });
  it.each(['live', 'faulted', 'revision', 'binding', 'bytes', 'mode'])(
    'V-AQ04-13 rejects %s restore fences',
    (kind) => {
      const { f, s } = stageFixture();
      try {
        commit(s);
        const point = s.checkpoint();
        if (kind === 'live') {
          f.child.alive = true;
          f.child.stopped = false;
        }
        if (kind === 'faulted') {
          f.child.alive = false;
          f.child.stopped = false;
        }
        if (kind === 'revision') s.advance();
        if (kind === 'binding') s.rebindIdentity();
        if (kind === 'bytes')
          writeFileSync(path.join(s.candidate, 'new'), 'later', { mode: 0o600 });
        if (kind === 'mode') chmodSync(path.join(s.candidate, 'config.yaml'), 0o400);
        expect(() => s.restore(point)).toThrow();
        expect(existsSync(path.join(f.root, 'recovered'))).toBe(false);
      } finally {
        s.cleanupModes();
      }
    }
  );
  it('V-AQ04-13 cannot mint a replacement checkpoint after later writes', () => {
    const { s } = stageFixture();
    try {
      commit(s);
      const old = s.checkpoint();
      s.advance();
      expect(() => s.restore(old)).toThrow();
      expect(() => s.checkpoint()).toThrow();
    } finally {
      s.cleanupModes();
    }
  });
  it('V-AQ04-09/10 detects source identity replacement and aggregate size overflow', () => {
    const { s } = stageFixture();
    const sourceFile = path.join(s.source, 'metadata.json');
    const bytes = readFileSync(sourceFile);
    try {
      chmodSync(s.source, 0o700);
      rmSync(sourceFile);
      writeFileSync(sourceFile, bytes, { mode: 0o400 });
      chmodSync(s.source, 0o500);
      expect(() => s.sourceUnchanged()).toThrow();
      const large = path.join(temp(), 'large');
      mkdirSync(large, { mode: 0o700 });
      for (let i = 0; i < 17; i++)
        writeFileSync(path.join(large, String(i)), Buffer.alloc(1024 * 1024), { mode: 0o600 });
      expect(() => stageTree(large)).toThrow('INPUT_LIMIT');
    } finally {
      for (const target of [s.source, s.snapshot, s.candidate]) {
        for (const entry of stageTree(target).entries)
          chmodSync(path.join(target, entry.name), entry.type === 'directory' ? 0o700 : 0o600);
      }
    }
  });
  it('V-AQ04-13 restores the entire snapshot to a fresh candidate including absent members', () => {
    const { s } = stageFixture();
    try {
      mkdirSync(path.join(s.candidate, 'auth'), { mode: 0o700 });
      writeFileSync(path.join(s.candidate, 'auth', 'new'), 'private', { mode: 0o600 });
      commit(s);
      const restored = s.restore(s.checkpoint());
      expect(existsSync(path.join(restored, 'auth'))).toBe(false);
      expect(readFileSync(path.join(restored, 'config.yaml'), 'utf8')).toContain(
        path.join(restored, 'auth')
      );
      s.sourceUnchanged();
    } finally {
      s.cleanupModes();
    }
  });
  it('V-AQ04-13 detects snapshot tamper without rewriting source', () => {
    const { s } = stageFixture();
    try {
      commit(s);
      const point = s.checkpoint();
      chmodSync(path.join(s.snapshot, 'metadata.json'), 0o600);
      writeFileSync(path.join(s.snapshot, 'metadata.json'), '{}');
      expect(() => s.restore(point)).toThrow();
      s.sourceUnchanged();
    } finally {
      s.cleanupModes();
    }
  });
});
