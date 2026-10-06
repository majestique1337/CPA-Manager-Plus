import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  linkSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boundedRequest,
  startStub,
  spawnOwned,
  childEnvironment,
  readOwnedFile,
  checkIsolation,
  createReport,
  selectCases,
  reportExit,
  runCli,
  naturalExpiry,
  dispatchManagement,
  openFixture,
  fixtureConfig,
} from '../bin/ci/run-cpa-v8-qualification.mjs';
import {
  createManagementManifest,
  createExternalManifest,
  validateEvidence,
} from '../bin/ci/validate-cpa-v8-evidence.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin/ci/run-cpa-v8-qualification.mjs');
const helper = path.join(repo, 'bin/ci/prepare-cpa-v8-artifact.py');
const encode = (v) => Buffer.from(JSON.stringify(v, null, 2) + '\n');
const secret = 'AQ02_PRIVATE_SENTINEL_MUST_NOT_ESCAPE';
let root, manifestPath;
const cleanups = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cpamp-aq02-test-')));
  manifestPath = path.join(root, 'manifest.json');
  writeFileSync(manifestPath, encode(createManagementManifest()), { mode: 0o600 });
});
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  rmSync(root, { recursive: true, force: true });
});
async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        instance.closeAllConnections();
        instance.close(resolve);
      })
  );
  return instance.address().port;
}
const request = (port, options = {}) => boundedRequest({ port, route: '/', ...options });

describe('AQ-02 V01–04 archive boundary (synthetic bytes, never execution)', () => {
  const script = `
import importlib.util, pathlib, io, tarfile, gzip, hashlib, json, sys, os
spec=importlib.util.spec_from_file_location('aq02',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]); mode=sys.argv[3]; raw=io.BytesIO()
elf=bytearray(64); elf[:7]=b'\\x7fELF\\x02\\x01\\x01'; elf[18:20]=b'\\x3e\\x00'
if mode=='bad-elf': elf[:4]=b'NOPE'
if mode=='bad-arch': elf[18:20]=b'\\xb7\\x00'
with tarfile.open(fileobj=raw,mode='w',format=tarfile.PAX_FORMAT) as t:
 for name in sorted(m.MEMBERS):
  data=bytes(elf) if name=='cli-proxy-api' else b'synthetic fixture'
  i=tarfile.TarInfo(name); i.size=len(data); i.mode=0o644
  if name=='LICENSE':
   if mode in ['absolute','traversal','unknown']: i.name={'absolute':'/outside','traversal':'../outside','unknown':'unknown'}[mode]
   if mode in ['symlink','hardlink','fifo','device','directory']: i.type={'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE,'device':tarfile.CHRTYPE,'directory':tarfile.DIRTYPE}[mode]; i.linkname='../outside'; i.size=0
   if mode=='permissions': i.mode=0o4755
   if mode=='metadata': i.pax_headers={'comment':'x'*70000}
  t.addfile(i,io.BytesIO(data))
  if name=='LICENSE' and mode=='duplicate': t.addfile(i,io.BytesIO(data))
data=gzip.compress(raw.getvalue())
if mode=='truncated': data=data[:-6]
if mode=='crc': data=data[:-8]+bytes([data[-8]^1])+data[-7:]
p=root/m.ASSET; p.write_bytes(data); p.chmod(0o600)
if mode=='archive-link': q=root/'actual'; p.rename(q); p.symlink_to(q)
if mode=='archive-hardlink': os.link(p,root/'alias')
if mode=='wrong-name': q=root/'wrong.tar.gz'; p.rename(q); p=q
dest=root/'staged'
if mode=='existing': dest.mkdir(); (dest/'keep').write_text('keep')
try:
 result=m.stage(p,dest,expected_sha='0'*64 if mode=='hash' else hashlib.sha256(data).hexdigest(),expected_size=len(data)+(1 if mode=='size' else 0))
 print(json.dumps({'accepted':True,'members':sorted(x.name for x in dest.iterdir()),'binaryHash':result['observedBinarySha256']}))
except Exception:
 print(json.dumps({'accepted':False,'staged':dest.exists(),'outside':(root/'outside').exists(),'kept':(dest/'keep').exists()}))
`;
  const stage = (mode) => {
    const r = spawnSync('python3', ['-I', '-B', '-c', script, helper, root, mode], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    return JSON.parse(r.stdout);
  };
  it('accepts the five regular members and observes an ELF hash', () => {
    const r = stage('valid');
    expect(r.accepted).toBe(true);
    expect(r.members).toHaveLength(5);
    expect(r.binaryHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    'hash',
    'size',
    'wrong-name',
    'archive-link',
    'archive-hardlink',
    'absolute',
    'traversal',
    'unknown',
    'symlink',
    'hardlink',
    'fifo',
    'device',
    'directory',
    'permissions',
    'duplicate',
    'metadata',
    'truncated',
    'crc',
    'bad-elf',
    'bad-arch',
  ])('V01–04 rejects %s and leaves no partial staging', (mode) =>
    expect(stage(mode)).toEqual({ accepted: false, staged: false, outside: false, kept: false })
  );
  it('V16 preserves an existing destination', () =>
    expect(stage('existing')).toEqual({
      accepted: false,
      staged: true,
      outside: false,
      kept: true,
    }));
  it('V03 bounds the decompressed reader before allocating an over-limit request', () => {
    const code = `import importlib.util,io,time,sys; s=importlib.util.spec_from_file_location('a',sys.argv[1]); m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for size,limit in [(65537,999999),(16,8)]:
 try: m.BoundedReader(io.BytesIO(b'x'*32),time.monotonic()+10,limit).read(size);sys.exit(2)
 except m.Rejected: pass
print('bounded')`;
    const r = spawnSync('python3', ['-I', '-B', '-c', code, helper], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('bounded');
  });
  it('CLI cannot override the pinned digest with a synthetic input', () => {
    stage('valid');
    const r = spawnSync(
      'python3',
      [
        '-I',
        '-B',
        helper,
        path.join(root, createManagementManifest().candidate.assetName),
        path.join(root, 'official'),
      ],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('{"errorCode":"ARTIFACT_INVALID"}');
    expect(existsSync(path.join(root, 'official'))).toBe(false);
  });
});

describe('AQ-02 bounded I/O and child ownership', () => {
  it.each([
    ['success', 1, true],
    ['transient', 2, true],
    ['disconnected', 2, false],
    ['denied', 1, false],
    ['wrong-identity', 1, false],
  ])('V07 bounds startup HTTP probes for %s', async (mode, attempts, accepted) => {
    const binary = path.join(root, 'fake-cpa');
    const counter = path.join(root, 'requests');
    const bytes = Buffer.from(`#!${process.execPath}
const fs=require('node:fs'),http=require('node:http');
const config=JSON.parse(fs.readFileSync(process.argv[3]));let count=0;
setTimeout(()=>http.createServer((req,res)=>{
  fs.writeFileSync(${JSON.stringify(counter)},String(++count));
  const mode=${JSON.stringify(mode)};
  if(mode==='disconnected'||(mode==='transient'&&count===1)){req.socket.destroy();return;}
  res.statusCode=mode==='denied'?401:200;
  res.end(JSON.stringify(mode==='wrong-identity'?{}:config));
}).listen(config.server.port,'127.0.0.1'),250);`);
    writeFileSync(binary, bytes, { mode: 0o500 });
    const spec = createManagementManifest().cases.find((c) => c.id === 'AQ02-M01-bearer');
    const opening = openFixture(
      root,
      spec,
      binary,
      createHash('sha256').update(bytes).digest('hex')
    );
    if (accepted) cleanups.push((await opening).clean);
    else await expect(opening).rejects.toThrow();
    expect(readFileSync(counter, 'utf8')).toBe(String(attempts));
  });
  it('V07 rejects an alive HTTP 200 service with the wrong config identity and cleans its fixture', async () => {
    const binary = path.join(root, 'fake-cpa');
    const bytes = Buffer.from(
      `#!${process.execPath}\nconst fs=require('node:fs'), http=require('node:http');const config=JSON.parse(fs.readFileSync(process.argv[3]));http.createServer((req,res)=>res.end(JSON.stringify({'config-version':8,server:{port:1}}))).listen(config.server.port,'127.0.0.1');`
    );
    writeFileSync(binary, bytes, { mode: 0o500 });
    const spec = createManagementManifest().cases.find((c) => c.id === 'AQ02-M01-bearer');
    await expect(
      openFixture(root, spec, binary, createHash('sha256').update(bytes).digest('hex'))
    ).rejects.toThrow('SETUP_FAILED');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(root).some((name) => name.startsWith('case-'))).toBe(false);
  });
  it('V08 cancels the listener wait and removes the owned fixture', async () => {
    const binary = path.join(root, 'fake-cpa');
    const bytes = Buffer.from(`#!${process.execPath}\nsetInterval(()=>{},1000);`);
    writeFileSync(binary, bytes, { mode: 0o500 });
    const spec = createManagementManifest().cases.find((c) => c.id === 'AQ02-M01-bearer');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await expect(
        openFixture(
          root,
          spec,
          binary,
          createHash('sha256').update(bytes).digest('hex'),
          controller.signal
        )
      ).rejects.toThrow('CANCELLED');
    } finally {
      clearTimeout(timer);
    }
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(root).some((name) => name.startsWith('case-'))).toBe(false);
  });
  it('V04 refuses a replaced binary before starting the child', async () => {
    const binary = path.join(root, 'fake-cpa');
    writeFileSync(binary, 'replaced', { mode: 0o500 });
    const spec = createManagementManifest().cases.find((c) => c.id === 'AQ02-M01-bearer');
    await expect(openFixture(root, spec, binary, '0'.repeat(64))).rejects.toThrow('SETUP_FAILED');
  });
  it('V04 rejects aliases, links, nonregular inputs and changed bytes', () => {
    const file = path.join(root, 'binary');
    writeFileSync(file, 'original', { mode: 0o500 });
    expect(readOwnedFile(file).toString()).toBe('original');
    const alias = path.join(root, 'alias');
    symlinkSync(file, alias);
    expect(() => readOwnedFile(alias)).toThrow();
    const hard = path.join(root, 'hard');
    linkSync(file, hard);
    expect(() => readOwnedFile(file)).toThrow();
    expect(() => readOwnedFile(root)).toThrow();
    expect(() => readOwnedFile(manifestPath, 10)).toThrow('INPUT_LIMIT');
  });
  it('V05 constructs an empty-allowlist environment despite host credentials', () => {
    const old = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = secret;
    try {
      expect(childEnvironment(root)).toEqual({
        HOME: root,
        TMPDIR: root,
        LANG: 'C.UTF-8',
        PATH: '/usr/local/bin:/usr/bin:/bin',
      });
    } finally {
      if (old === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = old;
    }
    expect(childEnvironment(root, 'owned-secret').MANAGEMENT_PASSWORD).toBe('owned-secret');
  });
  it('V08 discards excessive output and reaps only the recorded child', async () => {
    const child = spawnOwned(
      process.execPath,
      [
        '-e',
        `process.stdout.write('${secret}');for(let i=0;i<10000;i++)process.stdout.write('x'.repeat(1024));setInterval(()=>{},1000)`,
      ],
      { cwd: root, env: childEnvironment(root), outputLimit: 2048 }
    );
    cleanups.push(() => child.stop());
    await child.closed;
    expect(child.fault).toBe('INPUT_LIMIT');
    expect(child.output().length).toBe(0);
    expect(child.alive).toBe(false);
  });
  it('V08/14 cancels an owned child, escalating after the grace deadline', async () => {
    const controller = new AbortController();
    const child = spawnOwned(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
      { cwd: root, env: childEnvironment(root), signal: controller.signal }
    );
    cleanups.push(() => child.stop());
    await new Promise((resolve) => child.child.stdout.once('data', resolve));
    controller.abort();
    await child.stop();
    expect(child.fault).toBe('CANCELLED');
    expect(child.alive).toBe(false);
  }, 10000);
  it('V09 bounds body, headers and encoding, and never follows redirects', async () => {
    const port = await server((req, res) => {
      if (req.url === '/body') res.end('x'.repeat(1024 * 1024 + 1));
      else if (req.url === '/headers') {
        res.setHeader('x-long', 'x'.repeat(34000));
        res.end('{}');
      } else if (req.url === '/compressed') {
        res.setHeader('content-encoding', 'gzip');
        res.end('gzip');
      } else {
        res.writeHead(302, { location: 'https://example.invalid/' });
        res.end();
      }
    });
    for (const route of ['/body', '/headers', '/compressed'])
      await expect(request(port, { route })).rejects.toThrow('INPUT_LIMIT');
    expect((await request(port)).status).toBe(302);
  });
  it('V09 has an absolute deadline even for a trickling response, and honors cancellation', async () => {
    const port = await server((req, res) => {
      const timer = setInterval(() => res.write(' '), 10);
      res.on('close', () => clearInterval(timer));
    });
    await expect(request(port, { timeoutMs: 50 })).rejects.toThrow('TIMEOUT');
    const controller = new AbortController();
    const pending = request(port, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('CANCELLED');
  });
  it('V10 distinguishes stub key/shape rejection from a real provider error control', async () => {
    const stub = await startStub('owned-key');
    cleanups.push(() => stub.close());
    const body = {
      model: 'aq02-model',
      messages: [{ role: 'user', content: 'AQ02 synthetic request' }],
    };
    const options = {
      method: 'POST',
      route: '/v1/chat/completions',
      body,
      headers: { authorization: 'Bearer owned-key' },
    };
    expect((await request(stub.port, options)).status).toBe(200);
    expect(stub.requests).toBe(1);
    expect((await request(stub.port, { ...options, headers: {} })).status).toBe(400);
    expect(stub.requests).toBe(1);
    stub.fail(true);
    expect((await request(stub.port, options)).status).toBe(503);
    expect(stub.requests).toBe(2);
  });
  it('V11 response loss sends a mutation once and permits a separate readback', async () => {
    let count = 0,
      value;
    const port = await server((req, res) => {
      if (req.method === 'PUT') {
        count++;
        let body = '';
        req.on('data', (b) => {
          body += b;
        });
        req.on('end', () => {
          value = JSON.parse(body);
          res.end('{"ok":true}');
        });
      } else res.end(JSON.stringify(value));
    });
    expect(
      (await request(port, { method: 'PUT', body: ['replacement'], loseResponse: true })).status
    ).toBe(null);
    expect((await request(port)).json).toEqual(['replacement']);
    expect(count).toBe(1);
  });
});

function isolation() {
  return {
    Image: 'sha256:' + 'a'.repeat(64),
    Id: 'b'.repeat(64),
    Config: { User: '10001' },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: 1024 * 1024 * 1024,
      PidsLimit: 64,
      NanoCpus: 1e9,
      Privileged: false,
      PidMode: '',
      IpcMode: 'private',
      PortBindings: {},
      Tmpfs: {},
    },
    Mounts: [
      '/input/' + createManagementManifest().candidate.assetName,
      '/run/aq02-isolation.json',
      '/run/aq02-manifest.json',
      '/work',
    ].map((Destination) => ({ Type: 'bind', Destination, RW: Destination === '/work' })),
  };
}
const runtime = {
  platform: 'linux',
  arch: 'x64',
  uid: 10001,
  nodeMajor: 24,
  libc: '2.36',
  onlyLoopback: true,
  readonlyRoot: true,
  noNewPrivileges: true,
  noCapabilities: true,
};
describe('AQ-02 isolation, CLI and partial evidence', () => {
  it('V06 rejects every missing isolation guarantee', () => {
    expect(checkIsolation(isolation(), runtime).imageDigest).toMatch(/^sha256:/);
    for (const [key, value] of Object.entries({
      platform: 'darwin',
      arch: 'arm64',
      uid: 0,
      nodeMajor: 22,
      libc: '',
      onlyLoopback: false,
      readonlyRoot: false,
      noNewPrivileges: false,
      noCapabilities: false,
    }))
      expect(() => checkIsolation(isolation(), { ...runtime, [key]: value })).toThrow();
    for (const [key, value] of Object.entries({
      NetworkMode: 'host',
      ReadonlyRootfs: false,
      CapDrop: [],
      SecurityOpt: [],
      Memory: 0,
      PidsLimit: 0,
      NanoCpus: 0,
      Privileged: true,
      PidMode: 'host',
      IpcMode: 'host',
      PortBindings: { 80: [] },
    })) {
      const spec = isolation();
      spec.HostConfig[key] = value;
      expect(() => checkIsolation(spec, runtime)).toThrow();
    }
    const spec = isolation();
    spec.Mounts.push({ Destination: '/var/run/docker.sock', RW: true, Type: 'bind' });
    expect(() => checkIsolation(spec, runtime)).toThrow();
  });
  it('V12/14 callback HTTP 200 cannot manufacture a completed report', () => {
    const manifest = createManagementManifest(),
      selected = [manifest.cases.find((c) => c.id === 'AQ02-M29-error-callback')];
    const report = createReport(manifest, encode(manifest), selected);
    const evidence = path.join(root, 'evidence');
    mkdirSync(evidence, { mode: 0o700 });
    const reportPath = path.join(root, 'report.json');
    writeFileSync(reportPath, encode(report), { mode: 0o600 });
    expect(
      validateEvidence({ manifestPath, reportPath, evidenceRoot: evidence }).validationStatus
    ).toBe('report_valid');
    expect(reportExit(report, { validationStatus: 'report_valid' })).toBe(1);
    report.results[0].executionState = 'completed';
    report.results[0].assertionOutcome = 'pass';
    writeFileSync(reportPath, encode(report));
    expect(
      validateEvidence({ manifestPath, reportPath, evidenceRoot: evidence }).validationStatus
    ).toBe('invalid');
  });
  it('V14 failed setup/cleanup and partial selection never return success', () => {
    const manifest = createManagementManifest();
    const report = createReport(manifest, encode(manifest), selectCases(manifest, 'management-r2'));
    for (const state of ['not_run', 'aborted', 'completed']) {
      report.run.state = state;
      expect(reportExit(report, { validationStatus: 'report_valid' })).toBe(1);
    }
    expect(report.results.every((r) => r.capability === 'unknown')).toBe(true);
  });
  it('declares all 36 groups, keeps required downstream cases and separates natural expiry', () => {
    const m = createManagementManifest();
    expect(
      new Set(m.cases.filter((c) => c.id.startsWith('AQ02-')).map((c) => c.id.slice(0, 8))).size
    ).toBe(36);
    expect(selectCases(m, 'oauth-expiry-r2').map((c) => c.id)).toEqual(['AQ02-M32-natural-expiry']);
    expect(selectCases(m, 'management-r2')).toHaveLength(92);
    expect(
      m.cases.find((c) => c.id === 'AQ02-M33-real-exchange').expectations.every((e) => e.mandatory)
    ).toBe(true);
    expect(m.cases.some((c) => c.operationRef === 'USAGE-02')).toBe(true);
  });
  it('rejects mismatched revision and case-set instead of an empty successful run', () => {
    expect(() => selectCases(createExternalManifest(), 'management-r2')).toThrow('SETUP_FAILED');
    expect(() => selectCases(createManagementManifest(), 'external-safety-r3')).toThrow(
      'SETUP_FAILED'
    );
    expect(selectCases(createExternalManifest(), 'external-safety-r3')).toHaveLength(50);
  });
  it.each([
    ['--execute'],
    ['--run'],
    ['--manifest'],
    ['--manifest', 'x', '--manifest', 'y'],
    ['--manifest', 'x', '--case-set', 'arbitrary'],
    ['--run', '--run'],
  ])('V16 refuses unknown/duplicate flags %j', async (...args) => {
    const r = await runCli(args);
    expect(r.exitCode).toBe(2);
    expect(r.summary.errorCode).toBe('USAGE');
  });
  it('V15/16 invalid path and host --run do not leak raw errors or create an output', async () => {
    const r = await runCli(['--manifest', path.join(root, secret)]);
    expect(JSON.stringify(r)).not.toContain(secret);
    const out = path.join(root, 'must-not-exist');
    expect(
      (
        await runCli([
          '--run',
          '--manifest',
          manifestPath,
          '--archive',
          secret,
          '--output-parent',
          out,
          '--case-set',
          'management-r2',
        ])
      ).exitCode
    ).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
  it('V16 default plan invokes no network, process or write API', () => {
    const code = `import fs from 'node:fs';import http from 'node:http';import net from 'node:net';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {pathToFileURL} from 'node:url';
let calls=[];for(const [object,names] of [[fs,['writeFileSync','mkdirSync','mkdtempSync','rmSync','chmodSync']], [http,['request','createServer']], [net,['connect','createConnection','createServer']], [cp,['spawn','spawnSync','exec','execFile']]])for(const name of names)object[name]=()=>{calls.push(name);throw Error('trap')};syncBuiltinESMExports();process.argv[1]='harness';const {runCli}=await import(pathToFileURL(${JSON.stringify(cli)}));console.log(JSON.stringify({result:await runCli(['--manifest',${JSON.stringify(manifestPath)}]),calls}));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    const data = JSON.parse(r.stdout);
    expect(data.calls).toEqual([]);
    expect(data.result.exitCode).toBe(0);
  });
  it.each([{ flags: [] }, { flags: ['--preserve-symlinks-main'] }])(
    'CLI symlink still enforces flags ($flags)',
    ({ flags }) => {
      const alias = path.join(root, 'alias.mjs');
      symlinkSync(cli, alias);
      const r = spawnSync(process.execPath, [...flags, alias, '--execute'], { encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout).errorCode).toBe('USAGE');
    }
  );
});

describe('AQ-02 V13 natural expiry tool arithmetic, not real TTL evidence', () => {
  it('V13/14 cancellation retains the same-flow pending and error observations', async () => {
    let elapsed = 0;
    const f = {
      authDir: root,
      mgmt: async (method, route) =>
        route.startsWith('/oauth/auth-url')
          ? {
              status: 200,
              json: { status: 'ok', state: 'x', url: 'https://auth.openai.com/authorize?state=x' },
            }
          : {
              status: 200,
              json: elapsed < 300000 ? { status: 'wait' } : { status: 'error', error: 'timeout' },
            },
    };
    let caught;
    try {
      await naturalExpiry(
        f,
        () => elapsed,
        async (ms) => {
          elapsed += ms;
          if (elapsed > 300000) throw Object.assign(new Error('cancel'), { code: 'CANCELLED' });
        }
      );
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).toBe('CANCELLED');
    expect(caught?.points.map((p) => p.passed)).toEqual([true, true]);
  });
  it('requires the same state, pending then error then a full renewed TTL and no credential', async () => {
    let elapsed = 0;
    const state = 'ownedState';
    const f = {
      authDir: root,
      mgmt: async (method, route) =>
        route.startsWith('/oauth/auth-url')
          ? {
              status: 200,
              json: {
                status: 'ok',
                state,
                url: 'https://auth.openai.com/authorize?state=' + state,
              },
            }
          : {
              status: 200,
              json:
                elapsed < 300000
                  ? { status: 'wait' }
                  : elapsed < 2100000
                    ? { status: 'error', error: 'timeout' }
                    : { status: 'error', error: 'unknown or expired state' },
            },
    };
    // manifest.json is not a credential: use a distinct empty auth directory.
    f.authDir = path.join(root, 'auth');
    mkdirSync(f.authDir);
    const points = await naturalExpiry(
      f,
      () => elapsed,
      async (ms) => {
        elapsed += ms;
      }
    );
    expect(points.map((p) => p.passed)).toEqual([true, true, true, true]);
    expect(elapsed).toBe(2100000);
  });
  it('unknown state after one poll cannot stand in for natural expiry', async () => {
    let elapsed = 0;
    const f = {
      authDir: root,
      mgmt: async (method, route) =>
        route.startsWith('/oauth/auth-url')
          ? {
              status: 200,
              json: { status: 'ok', state: 'x', url: 'https://auth.openai.com/authorize?state=x' },
            }
          : {
              status: 200,
              json:
                elapsed === 0
                  ? { status: 'wait' }
                  : { status: 'error', error: 'unknown or expired state' },
            },
    };
    const points = await naturalExpiry(
      f,
      () => elapsed,
      async (ms) => {
        elapsed += ms;
      }
    );
    expect(points.some((p) => !p.passed)).toBe(true);
  });
});

describe('AQ-02 config postconditions (synthetic management responses)', () => {
  it.each([
    ['AQ02-M14-map-patch', false, true],
    ['AQ02-M14-map-patch', true, false],
    ['AQ02-M13-root-put', false, true],
    ['AQ02-M13-root-put', true, false],
    ['AQ02-M17-yaml-put', false, true],
    ['AQ02-M17-yaml-put', true, false],
  ])('%s rejects a broken postcondition=%s', async (id, broken, expected) => {
    const config = fixtureConfig({
      port: 12345,
      stubPort: 12346,
      authDir: root,
      managementKey: 'management',
      clientKey: 'client',
      upstreamKey: 'upstream',
    });
    let state = structuredClone(config);
    const filename = path.join(root, 'config.yaml');
    writeFileSync(filename, encode(state), { mode: 0o600 });
    const f = {
      filename,
      config,
      authDir: root,
      stub: { requests: 0 },
      async data(key = 'client') {
        if (!state.access?.['api-keys']?.includes(key))
          return { status: 401, json: { error: 'invalid key' } };
        this.stub.requests++;
        return { status: 200, json: { choices: [{ message: { content: 'AQ02_OK' } }] } };
      },
      async mgmt(method, route, body) {
        if (method === 'GET') {
          const projected = structuredClone(state);
          const ice = projected.oauth?.providers?.codex?.['live-media-relay']?.['ice-servers']?.[0];
          if (ice) {
            delete ice.username;
            delete ice.credential;
          }
          return { status: 200, json: projected };
        }
        const old = structuredClone(state);
        state = method === 'PATCH' && !broken ? { ...state, ...body } : structuredClone(body);
        const ice = state.oauth?.providers?.codex?.['live-media-relay']?.['ice-servers']?.[0];
        const previous = old.oauth.providers.codex['live-media-relay']['ice-servers'][0];
        if (ice && ((route === '/config' && !broken) || (route === '/config.yaml' && broken)))
          Object.assign(ice, previous);
        writeFileSync(filename, encode(state));
        return { status: 200, json: { status: 'ok' } };
      },
    };
    const result = await dispatchManagement(
      createManagementManifest().cases.find((c) => c.id === id),
      f
    );
    expect(result.checks[1]).toBe(expected);
  });
});
