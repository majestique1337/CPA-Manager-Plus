import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSeedManifest,
  createManagementManifest,
  createExternalManifest,
  validateEvidence,
} from '../bin/ci/validate-cpa-v8-evidence.mjs';
import { runCli, selectCases, createReport } from '../bin/ci/run-cpa-v8-qualification.mjs';
import {
  externalTarget,
  externalRead,
  externalServer,
  dispatchExternal,
  cleanExternalEnvironment,
  bindingFence,
  projectRequired,
} from '../bin/ci/cpa-v8-external-fixtures.mjs';

let root;
const cleaners = [];
const encode = (x) => JSON.stringify(x, null, 2) + '\n';
const value = () => ({
  'config-version': 8,
  server: { port: 8317 },
  oauth: { 'auth-dir': '/private/owned' },
  access: { 'api-keys': ['private_fixture'] },
});
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cpamp-aq03-test-')));
});
afterEach(async () => {
  for (const fn of cleaners.splice(0).reverse()) await fn();
  rmSync(root, { recursive: true, force: true });
});
const serve = async (handler, options) => {
  const s = await externalServer(handler, options);
  cleaners.push(() => s.close());
  return s;
};

describe('AQ-03 frozen scope and report boundaries', () => {
  it('V01/02 preserves all revisions and selects only this scope', async () => {
    for (const m of [createSeedManifest(), createManagementManifest(), createExternalManifest()]) {
      const p = path.join(root, m.revision + '.json');
      writeFileSync(p, encode(m));
      expect(validateEvidence({ manifestPath: p }).validationStatus).toBe('manifest_valid');
    }
    const m = createExternalManifest();
    expect(m.cases.length).toBe(64);
    const selected = selectCases(m, 'external-safety-r3');
    expect(selected.length).toBe(50);
    expect(() => selectCases(m, 'management-r2')).toThrow('SETUP_FAILED');
    expect(() => selectCases(createManagementManifest(), 'external-safety-r3')).toThrow(
      'SETUP_FAILED'
    );
    expect(new Set(selected.map((c) => c.id.slice(0, 8))).size).toBe(28);
    expect(selected.every((c) => c.budgetRef === 'standard-r1')).toBe(true);
    expect(
      createReport(m, Buffer.from(encode(m)), selected).results.every(
        (r) => r.capability === 'unknown'
      )
    ).toBe(true);
    const result = await runCli(['--manifest', path.join(root, 'r3.json')]);
    expect(result.exitCode).toBe(0);
    expect(result.summary.completed).toBe(0);
    expect(
      (await runCli(['--manifest', path.join(root, 'r3.json'), '--url', 'https://private.invalid']))
        .exitCode
    ).toBe(2);
  });
  it.each(['required', 'profile', 'budget', 'foreign', 'url'])(
    'V01/02/03 rejects %s manifest drift',
    (kind) => {
      const m = createExternalManifest(),
        c = m.cases.find((x) => x.id.startsWith('AQ03-'));
      if (kind === 'required') c.expectations[0].mandatory = false;
      if (kind === 'profile') m.profiles[0].requiredOperationRefs.pop();
      if (kind === 'budget') c.budgetRef = 'oauth-expiry-r2';
      if (kind === 'foreign') c.id = 'AQ02-M01-bearer';
      if (kind === 'url') c.url = 'https://private.invalid';
      const p = path.join(root, 'manifest.json');
      writeFileSync(p, encode(m));
      expect(validateEvidence({ manifestPath: p }).validationStatus).toBe('invalid');
    }
  );
  it('V03/10 does not pool evidence or publish an old binding', () => {
    const fence = bindingFence({ target: 'A', credential: 1 });
    const ticket = fence.capture();
    fence.change({ target: 'B', credential: 2 });
    fence.change({ target: 'A', credential: 1 });
    expect(fence.publish(ticket, true)).toBe(null);
    const fact = {
      id: 'read',
      accepted: true,
      outcome: 'pass',
      proofScope: 'harness-behavior',
      capability: 'supported',
    };
    expect(projectRequired(['read'], [fact]).ready).toBe(false);
    expect(() => projectRequired(['read'], [fact, fact])).toThrow('SETUP_FAILED');
    expect(
      projectRequired(['read'], [{ ...fact, proofScope: 'upstream-function', outcome: 'fail' }])
        .state
    ).toBe('unknown');
    expect(
      projectRequired(['read', 'write'], [{ ...fact, proofScope: 'upstream-function' }]).state
    ).toBe('partial');
  });
});

describe('AQ-03 actual owned local fixtures (not upstream qualification)', () => {
  const cases = selectCases(createExternalManifest(), 'external-safety-r3').filter(
    (c) => c.proofScope !== 'upstream-function'
  );
  it.each(cases.map((c) => [c.id, c]))(
    '%s',
    async (_id, spec) => {
      const f = { root, managementKey: 'AQ03_PRIVATE_KEY', signal: new AbortController().signal };
      const result = await dispatchExternal(spec, f);
      expect(result.checks).toEqual([true, true, true]);
    },
    20000
  );
  it('V08/09 applies one total deadline to a slow stream and destroys the channel', async () => {
    let closed = false;
    const s = await serve((req, res) => {
      req.socket.once('close', () => {
        closed = true;
      });
      res.setHeader('content-type', 'application/json');
      const timer = setInterval(() => res.write(' '), 10);
      res.once('close', () => clearInterval(timer));
    });
    const started = performance.now();
    await expect(
      externalRead(externalTarget({ port: s.port }), { key: 'private', timeoutMs: 80 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(true);
    expect(s.requests).toBe(1);
  });
  it('V09 accepts exactly one MiB decoded and rejects limit plus one', async () => {
    for (const delta of [0, 1]) {
      const body = value();
      body.padding = '';
      const size = Buffer.byteLength(JSON.stringify(body));
      body.padding = 'x'.repeat(1024 * 1024 - size + delta);
      const s = await serve((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-encoding', 'gzip');
        res.end(gzipSync(JSON.stringify(body)));
      });
      const request = externalRead(externalTarget({ port: s.port }));
      if (delta === 0) expect((await request).status).toBe(200);
      else await expect(request).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    }
  });
  it('V04/06 guards injected environment and keeps native errors private', async () => {
    expect(() => cleanExternalEnvironment({ NODE_OPTIONS: '--require /private' })).toThrow(
      'AUTH_REJECTED'
    );
    expect(() => cleanExternalEnvironment({}, ['--use-env-proxy'])).toThrow('AUTH_REJECTED');
    const s = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('AQ03_PRIVATE_SENTINEL');
    });
    try {
      await externalRead(externalTarget({ port: s.port }));
      throw Error('must fail');
    } catch (e) {
      expect(e.message).toBe('BODY_SCHEMA_MISMATCH');
      expect(JSON.stringify(e)).not.toContain('PRIVATE_SENTINEL');
    }
  });
});
