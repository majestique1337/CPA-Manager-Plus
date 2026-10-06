// AQ-04 synthetic source experiments, never a product backup/restore API.
import {
  constants,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  chmodSync,
  lstatSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const MiB = 1024 * 1024;
const fail = (code = 'SETUP_FAILED') => {
  throw Object.assign(new Error(code), { code });
};
const need = (condition, code) => {
  if (!condition) fail(code);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stamp = (s) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs, s.nlink];
const encode = (value) => JSON.stringify(value, null, 2) + '\n';

export function readOwnedFile(
  filename,
  limit = MiB,
  owner = typeof process.getuid === 'function' ? process.getuid() : null
) {
  need(path.isAbsolute(filename) && realpathSync(filename) === filename);
  const before = lstatSync(filename);
  need(
    before.isFile() &&
      before.nlink === 1 &&
      !(before.mode & 0o022) &&
      (owner === null || before.uid === owner)
  );
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    need(equal(stamp(before), stamp(fstatSync(fd))));
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, Math.min(65536, bytes.length - count), null);
      if (!n) break;
      count += n;
    }
    need(count <= limit, 'INPUT_LIMIT');
    need(
      equal(stamp(before), stamp(fstatSync(fd))) && equal(stamp(before), stamp(lstatSync(filename)))
    );
    return bytes.subarray(0, count);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function stageTree(directory) {
  need(path.isAbsolute(directory) && realpathSync(directory) === directory);
  const entries = [],
    identities = [];
  let total = 0;
  const visit = (relative) => {
    need(entries.length < 64, 'INPUT_LIMIT');
    const filename = path.join(directory, relative),
      before = lstatSync(filename);
    need(
      !before.isSymbolicLink() &&
        (before.isDirectory() || before.isFile()) &&
        before.uid === process.getuid()
    );
    need(!(before.mode & 0o022));
    identities.push([relative, stamp(before)]);
    if (before.isDirectory()) {
      const members = readdirSync(filename).sort();
      need(members.length + entries.length <= 64, 'INPUT_LIMIT');
      entries.push({ name: relative, type: 'directory', mode: before.mode & 0o777 });
      for (const member of members) visit(path.join(relative, member));
      need(equal(members, readdirSync(filename).sort()));
    } else {
      need(before.nlink === 1 && before.size <= MiB, 'INPUT_LIMIT');
      const bytes = readOwnedFile(filename);
      total += bytes.length;
      need(total <= 16 * MiB, 'INPUT_LIMIT');
      entries.push({
        name: relative,
        type: 'file',
        mode: before.mode & 0o777,
        size: bytes.length,
        sha256: hash(bytes),
      });
    }
    need(equal(stamp(before), stamp(lstatSync(filename))));
  };
  visit('');
  return { entries, identities };
}

function copyTree(source, destination, expected) {
  need(!existsSync(destination));
  need(equal(stageTree(source), expected));
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of expected.entries.slice(1)) {
    const target = path.join(destination, entry.name);
    need(target.startsWith(destination + path.sep));
    if (entry.type === 'directory') mkdirSync(target, { mode: 0o700 });
    else
      writeFileSync(target, readOwnedFile(path.join(source, entry.name)), {
        flag: 'wx',
        mode: entry.mode,
      });
  }
  // Parents become read-only only after the complete copy exists.
  for (const entry of [...expected.entries].reverse())
    chmodSync(path.join(destination, entry.name), entry.mode);
  need(equal(stageTree(destination).entries, expected.entries));
  need(equal(stageTree(source), expected));
}

function modes(directory, writable) {
  const tree = stageTree(directory);
  const entries = writable ? tree.entries : [...tree.entries].reverse();
  for (const entry of entries)
    chmodSync(
      path.join(directory, entry.name),
      entry.type === 'directory' ? (writable ? 0o700 : 0o500) : writable ? 0o600 : 0o400
    );
}

export function legacyConfig(v8, secret) {
  const providers = structuredClone(v8['api-keys']['openai-compatibility']);
  for (const provider of providers) {
    provider['api-key-entries'] = provider.keys;
    delete provider.keys;
  }
  return {
    host: '127.0.0.1',
    port: v8.server.port,
    'trusted-proxies': [],
    discovery: { enabled: false },
    'remote-management': { ...v8.management, 'secret-key': secret },
    'api-keys': v8.access['api-keys'],
    'auth-dir': v8.oauth['auth-dir'],
    'openai-compatibility': providers,
    'request-retry': 0,
    'max-retry-interval': 0,
    'usage-statistics-enabled': false,
    'logging-to-file': false,
    'request-log': false,
    plugins: { enabled: false },
    home: { enabled: false },
    pprof: { enable: false },
  };
}

// The owner is the runner's newly allocated case, with a recorded child. No CLI
// path can select source, snapshot, candidate, or recovery targets.
export function createStage(f, document, seedCredential = false) {
  const root = realpathSync(f.root);
  need(root === f.root && lstatSync(root).isDirectory() && !(lstatSync(root).mode & 0o077));
  const source = path.join(root, 'source'),
    snapshot = path.join(root, 'snapshot'),
    candidate = path.join(root, 'candidate');
  for (const target of [source, snapshot, candidate, path.join(root, 'recovered')])
    need(!existsSync(target));
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(path.join(source, 'home'), { mode: 0o700 });
  const sourceDoc = structuredClone(document);
  if (sourceDoc['config-version'] === 8) sourceDoc.oauth['auth-dir'] = path.join(source, 'auth');
  else sourceDoc['auth-dir'] = path.join(source, 'auth');
  writeFileSync(path.join(source, 'config.yaml'), encode(sourceDoc), { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(source, 'metadata.json'), encode({ fixture: 'AQ04', schema: 1 }), {
    flag: 'wx',
    mode: 0o600,
  });
  if (seedCredential) {
    mkdirSync(path.join(source, 'auth'), { mode: 0o700 });
    writeFileSync(
      path.join(source, 'auth/aq04-synthetic.json'),
      encode({
        type: 'aq02-synthetic',
        access_token: 'aq04-owned-synthetic',
        email: 'fixture@example.invalid',
      }),
      { flag: 'wx', mode: 0o600 }
    );
  }
  modes(source, false);
  const frozen = stageTree(source);
  copyTree(source, snapshot, frozen);
  const frozenSnapshot = stageTree(snapshot);
  copyTree(snapshot, candidate, frozenSnapshot);
  const points = new WeakMap();
  let checkpointTaken = false;
  let revision = 0,
    binding = {},
    committed = false;
  const sourceUnchanged = () => need(equal(stageTree(source), frozen));
  const completeSnapshot = () => need(equal(stageTree(snapshot), frozenSnapshot));
  const rebind = (target) => {
    modes(target, true);
    const doc = JSON.parse(readOwnedFile(path.join(target, 'config.yaml')));
    if (doc['config-version'] === 8) doc.oauth['auth-dir'] = path.join(target, 'auth');
    else doc['auth-dir'] = path.join(target, 'auth');
    writeFileSync(path.join(target, 'config.yaml'), encode(doc), { mode: 0o600 });
    need(!readOwnedFile(path.join(target, 'config.yaml')).includes(Buffer.from(source)));
    sourceUnchanged();
    completeSnapshot();
  };
  rebind(candidate);
  return {
    source,
    snapshot,
    candidate,
    sourceUnchanged,
    bytes: () => readOwnedFile(path.join(candidate, 'config.yaml')),
    tree: () => stageTree(candidate),
    observeCommit(before) {
      sourceUnchanged();
      const changed = !before.equals(readOwnedFile(path.join(candidate, 'config.yaml')));
      committed ||= changed;
      if (changed) revision++;
      return changed;
    },
    checkpoint(commitKnown = true) {
      sourceUnchanged();
      completeSnapshot();
      need(f.child.stopped && !checkpointTaken);
      checkpointTaken = true;
      const token = Object.freeze({});
      points.set(token, { tree: stageTree(candidate), revision, binding, committed, commitKnown });
      return token;
    },
    advance() {
      revision++;
    },
    rebindIdentity() {
      binding = {};
    },
    restore(token) {
      sourceUnchanged();
      completeSnapshot();
      const point = points.get(token);
      need(
        point &&
          f.child.stopped &&
          point.commitKnown &&
          point.committed &&
          point.revision === revision &&
          point.binding === binding &&
          equal(point.tree, stageTree(candidate))
      );
      const recovered = path.join(root, 'recovered');
      copyTree(snapshot, recovered, frozenSnapshot);
      // Complete comparison includes absence of candidate-created auth/state.
      need(equal(stageTree(recovered).entries, frozen.entries));
      rebind(recovered);
      points.delete(token);
      return recovered;
    },
    discardPrecommit() {
      sourceUnchanged();
      need(f.child.stopped && !committed);
      modes(candidate, true);
      rmSync(candidate, { recursive: true });
      sourceUnchanged();
      completeSnapshot();
    },
    cleanupModes() {
      // Record source integrity before relaxing only task-owned cleanup modes.
      sourceUnchanged();
      for (const target of [source, snapshot, candidate, path.join(root, 'recovered')])
        if (existsSync(target)) modes(target, true);
    },
  };
}

export async function dispatchUsageStage(spec, f) {
  const number = Number(spec.id.match(/^AQ04-S(\d{2})-/)?.[1]);
  need(number >= 1 && number <= 16);
  // An explicitly separate preparation process supplies a hash. It is not the
  // synthetic source; that source is frozen below and is never started.
  const prepared = readOwnedFile(f.filename).toString();
  const secret = prepared.match(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/)?.[0];
  need(secret);
  await f.stop();
  const document = [4, 5].includes(number)
    ? structuredClone(f.config)
    : legacyConfig(f.config, secret);
  if ([4, 5].includes(number)) document.management['secret-key'] = secret;
  if (number === 3 || number === 8) document['remote-management']['secret-key'] = f.managementKey;
  if (number === 4) {
    document.port = 1;
  }
  let stage,
    observation = false,
    state = false,
    control = false,
    response;
  const controls = async () => {
    response = await f.mgmt('GET', '/config');
    const cfg = response.json;
    need(
      response.status === 200 &&
        cfg?.server?.port === f.config.server.port &&
        cfg?.oauth?.['auth-dir'] === f.authDir
    );
    need((await f.mgmt('GET', '/config', undefined, null)).status === 401);
    need(equal((await f.mgmt('GET', '/config/access/api-keys')).json, [f.clientKey]));
    need((await f.mgmt('GET', '/credentials')).status === 200);
    const models = await f.mgmt('GET', '/credentials/models?name=aq04-absent.json');
    need(models.status === 200 && Array.isArray(models.json?.models));
    const count = f.stub.requests,
      data = await f.data();
    need(data.json?.choices?.[0]?.message?.content === 'AQ02_OK' && f.stub.requests === count + 1);
    return true;
  };
  const write = async (value, loseResponse = false) => {
    const before = stage.bytes();
    response = await f.mgmt(
      'PUT',
      '/config/routing/retry/request-retry',
      value,
      undefined,
      undefined,
      { loseResponse }
    );
    need(loseResponse ? response.status === null : response.status === 200);
    const changed = stage.observeCommit(before);
    const observed = await f.mgmt('GET', '/config/routing/retry/request-retry');
    need(changed && observed.status === 200 && observed.json === value);
    await delay(300, undefined, { signal: f.signal }).catch((error) => {
      if (f.signal?.aborted) fail('CANCELLED');
      throw error;
    });
    return true;
  };
  const rejected = (action) => {
    try {
      action();
      return false;
    } catch (error) {
      return error.code === 'SETUP_FAILED';
    }
  };
  try {
    stage = createStage(f, document, number === 5);
    const before = stage.bytes();
    if (number === 1 || number === 12) {
      observation = !existsSync(path.join(stage.source, 'auth'));
      state = stage.tree().entries.some((e) => e.name === 'metadata.json');
      stage.discardPrecommit();
      control = !existsSync(stage.candidate);
    } else if (number === 7) {
      writeFileSync(path.join(stage.candidate, 'config.yaml'), 'server: [\n', { mode: 0o600 });
      let failed = false;
      try {
        await f.startCandidate();
      } catch {
        failed = true;
      }
      await f.stop();
      observation = failed && f.child.stopped;
      state = stage.bytes().length > 0;
      stage.sourceUnchanged();
      control = true;
    } else {
      if (number === 8) {
        mkdirSync(path.join(stage.candidate, 'auth'), { mode: 0o700 });
        chmodSync(path.join(stage.candidate, 'config.yaml'), 0o400);
        chmodSync(stage.candidate, 0o500);
        let denied = false;
        try {
          const fd = openSync(path.join(stage.candidate, 'config.yaml'), constants.O_WRONLY);
          closeSync(fd);
        } catch (error) {
          denied = ['EACCES', 'EROFS'].includes(error.code);
        }
        need(denied); // Host-shared filesystems must not silently defeat this control.
      }
      await f.startCandidate();
      const afterStartup = stage.bytes(),
        startupChanged = stage.observeCommit(before);
      stage.sourceUnchanged();
      control = await controls();
      if ([2, 3, 4, 5, 6, 8].includes(number)) {
        const beforeRead = stage.bytes();
        await f.mgmt('GET', '/config');
        observation =
          number === 3
            ? startupChanged && !afterStartup.includes(Buffer.from(f.managementKey))
            : number === 4
              ? startupChanged
              : number === 8
                ? !startupChanged && afterStartup.includes(Buffer.from(f.managementKey))
                : number === 2
                  ? !startupChanged
                  : true;
        state =
          beforeRead.equals(stage.bytes()) &&
          existsSync(f.authDir) &&
          (number === 5
            ? existsSync(path.join(stage.source, 'auth'))
            : !existsSync(path.join(stage.source, 'auth')));
      } else if (number === 10) {
        const beforeRejected = stage.bytes();
        response = await f.mgmt('PUT', '/config/server/port', []);
        observation = [400, 422].includes(response.status);
        state = beforeRejected.equals(stage.bytes());
      } else {
        observation = await write(1, number === 11);
        state = !stage.bytes().equals(afterStartup);
        control &&= await controls();
        await f.stop(number === 16);
        stage.sourceUnchanged();
        const point = stage.checkpoint();
        if (number === 14) {
          stage.advance();
          state &&= rejected(() => stage.restore(point));
        } else if (number === 15) {
          stage.rebindIdentity();
          state &&= rejected(() => stage.restore(point));
        } else if (number === 13 || number === 16) {
          const recovered = stage.restore(point);
          state &&= !existsSync(path.join(recovered, 'auth'));
          await f.startCandidate('recovered');
          control &&= await controls();
          need((await f.mgmt('GET', '/config/routing/retry/request-retry')).json === 0);
        }
      }
    }
    await f.stop();
    stage.sourceUnchanged();
    return { response, checks: [observation, state, control], limited: true };
  } finally {
    await f.stop();
    stage?.cleanupModes();
  }
}
