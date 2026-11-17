import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgDeviceStoreError, createAgDeviceProfiles, deviceProfileKey } from './remote-ag-devices.mjs';

const FIELDS = ['os', 'arch', 'user_name', 'app_data_dir', 'time_zone', 'installation_id'];
const roots = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'zproxy-ag-devices-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** One official antigravity.Device JSON value; the installation id is explicit. */
function official(email, installationId) {
  const name = email.split('@')[0].replace(/[^A-Za-z0-9]/gu, '');
  return { os: 'linux', arch: 'x64', user_name: name, app_data_dir: `/home/${name}/.gemini/antigravity`,
    time_zone: 'Asia/Shanghai', installation_id: installationId };
}

const identity = (credentialId, email) => ({ credentialId, email });

test('one identity keeps one persisted device across reopenings', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  let calls = 0;
  const generate = email => { calls++; return official(email, 'installation-first'); };

  const first = createAgDeviceProfiles({ path, generate });
  const profile = await first.get(identity('credential-a', 'User@Example.com'));
  expect(Object.keys(profile)).toEqual(FIELDS);
  expect(profile).toEqual(official('User@Example.com', 'installation-first'));
  expect(calls).toBe(1);

  const reopened = createAgDeviceProfiles({ path, generate });
  expect(await reopened.get(identity('credential-a', 'user@example.com'))).toEqual(profile);
  expect(calls).toBe(1);
});

test('concurrent lookups of one identity create a single device', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  let calls = 0;
  const generate = async email => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return official(email, `installation-${calls}`);
  };
  const store = createAgDeviceProfiles({ path, generate });
  const results = await Promise.all(Array.from({ length: 8 }, () => store.get(identity('credential-b', 'same@example.com'))));
  expect(calls).toBe(1);
  expect(new Set(results.map(result => result.installation_id)).size).toBe(1);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(Object.keys(saved)).toEqual([deviceProfileKey(identity('credential-b', 'same@example.com'))]);
});

test('distinct credentials and mailboxes keep distinct devices', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  let calls = 0;
  const store = createAgDeviceProfiles({ path, generate: email => official(email, `installation-${++calls}`) });
  const one = await store.get(identity('credential-c', 'one@example.com'));
  const two = await store.get(identity('credential-c', 'two@example.com'));
  const three = await store.get(identity('credential-d', 'one@example.com'));
  expect(calls).toBe(3);
  expect(new Set([one.installation_id, two.installation_id, three.installation_id]).size).toBe(3);
  expect(await store.get(identity('credential-c', 'one@example.com'))).toEqual(one);
  expect(calls).toBe(3);
});

test('the store file is private and never carries identity or tokens', async () => {
  const root = await tempRoot();
  const nested = join(root, 'private');
  const path = join(nested, 'devices.json');
  const store = createAgDeviceProfiles({ path, generate: email => ({ ...official(email, 'installation-private'), access_token: 'secret-token', email }) });
  const profile = await store.get(identity('credential-secret-id', 'owner@example.com'));
  expect(profile).not.toHaveProperty('access_token');
  expect(profile).not.toHaveProperty('email');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(nested)).mode & 0o777).toBe(0o700);
  const text = await readFile(path, 'utf8');
  expect(text).not.toContain('owner@example.com');
  expect(text).not.toContain('credential-secret-id');
  expect(text).not.toContain('secret-token');
  const saved = JSON.parse(text);
  expect(Object.keys(saved)).toEqual([deviceProfileKey(identity('credential-secret-id', 'owner@example.com'))]);
  expect(Object.keys(saved[Object.keys(saved)[0]])).toEqual(FIELDS);
});

test('writing a second device keeps the first and stays atomic', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  let calls = 0;
  const store = createAgDeviceProfiles({ path, generate: email => official(email, `installation-${++calls}`) });
  const first = await store.get(identity('credential-i', 'first@example.com'));
  const second = await store.get(identity('credential-j', 'second@example.com'));
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(Object.keys(saved).sort()).toEqual([
    deviceProfileKey(identity('credential-i', 'first@example.com')),
    deviceProfileKey(identity('credential-j', 'second@example.com')),
  ].sort());
  expect(saved[deviceProfileKey(identity('credential-i', 'first@example.com'))]).toEqual(first);
  expect(saved[deviceProfileKey(identity('credential-j', 'second@example.com'))]).toEqual(second);
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('a device file seeded with official profiles is read as it stands', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  const key = deviceProfileKey(identity('credential-e', 'seeded@example.com'));
  const seeded = official('seeded@example.com', 'seeded-serial');
  await writeFile(path, JSON.stringify({ [key]: seeded }), 'utf8');
  let calls = 0;
  const store = createAgDeviceProfiles({ path, generate: email => { calls++; return official(email, 'unused'); } });
  expect(await store.get(identity('credential-e', 'seeded@example.com'))).toEqual(seeded);
  expect(calls).toBe(0);
});

test('a readable seed is tightened to private permissions on load', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  const key = deviceProfileKey(identity('credential-l', 'legacy@example.com'));
  const seeded = official('legacy@example.com', 'installation-legacy');
  await writeFile(path, JSON.stringify({ [key]: seeded }), 'utf8');
  await chmod(path, 0o644);
  const store = createAgDeviceProfiles({ path, generate: email => official(email, 'unused') });
  expect(await store.get(identity('credential-l', 'legacy@example.com'))).toEqual(seeded);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test('an incomplete login device is rejected before it can be used', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  const key = deviceProfileKey(identity('credential-m', 'login@example.com'));
  const login = { os: 'linux', arch: 'x64', user_name: '', app_data_dir: '', time_zone: 'UTC', installation_id: 'installation-login' };
  await writeFile(path, JSON.stringify({ [key]: login }), 'utf8');
  const store = createAgDeviceProfiles({ path, generate: () => { throw new Error('must not generate'); } });
  await expect(store.get(identity('credential-m', 'login@example.com'))).rejects.toMatchObject({ code: 'invalid' });
});

test('a corrupt store fails loudly without naming the store', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  await writeFile(path, '{ not json', 'utf8');
  const store = createAgDeviceProfiles({ path, generate: email => official(email, 'installation-corrupt') });
  const error = await store.get(identity('credential-f', 'broken@example.com')).then(() => undefined, reason => reason);
  expect(error).toBeInstanceOf(AgDeviceStoreError);
  expect(error.code).toBe('corrupt');
  expect(error.message).not.toContain(root);
  expect(error.message).not.toContain('broken@example.com');

  await rm(path);
  await mkdir(path);
  const replaced = await store.get(identity('credential-f', 'broken@example.com')).then(() => undefined, reason => reason);
  expect(replaced.code).toBe('unreadable');
  expect(replaced.message).not.toContain(root);
});

test('a foreign key in the store is refused instead of guessed at', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  await writeFile(path, JSON.stringify({ 'plain-address@example.com': official('x@example.com', 'installation-foreign') }), 'utf8');
  const store = createAgDeviceProfiles({ path, generate: email => official(email, 'unused') });
  const error = await store.get(identity('credential-k', 'foreign@example.com')).then(() => undefined, reason => reason);
  expect(error.code).toBe('corrupt');
  expect(error.message).not.toContain('plain-address@example.com');
});

test('a failed generation is reported and a retry succeeds', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  let attempt = 0;
  const generate = email => {
    attempt++;
    if (attempt === 1) throw new Error(`generator exploded for ${email}`);
    return official(email, 'installation-retry');
  };
  const store = createAgDeviceProfiles({ path, generate });
  const first = await store.get(identity('credential-g', 'retry@example.com')).then(() => undefined, reason => reason);
  expect(first).toBeInstanceOf(AgDeviceStoreError);
  expect(first.code).toBe('generate');
  expect(first.message).not.toContain('retry@example.com');
  expect(await store.get(identity('credential-g', 'retry@example.com'))).toEqual(official('retry@example.com', 'installation-retry'));
  expect(attempt).toBe(2);

  const invalid = createAgDeviceProfiles({ path: join(root, 'invalid.json'), generate: async () => ({ os: 'linux' }) });
  const second = await invalid.get(identity('credential-h', 'partial@example.com')).then(() => undefined, reason => reason);
  expect(second.code).toBe('invalid');
});

test('concurrent distinct identities are all persisted', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  let calls = 0;
  const store = createAgDeviceProfiles({ path, generate: async email => {
    await new Promise(resolve => setTimeout(resolve, 3));
    return official(email, `installation-${++calls}`);
  } });
  const wanted = Array.from({ length: 6 }, (_, index) => identity(`credential-multi-${index}`, `multi${index}@example.com`));
  const saved = await Promise.all(wanted.map(request => store.get(request)));
  expect(calls).toBe(6);
  expect(new Set(saved.map(device => device.installation_id)).size).toBe(6);
  const reopened = createAgDeviceProfiles({ path, generate: () => { throw new Error('must not generate'); } });
  for (const [index, request] of wanted.entries()) expect(await reopened.get(request)).toEqual(saved[index]);
});

test('the store refuses a new identity once its entries reach the bound', async () => {
  const root = await tempRoot();
  const path = join(root, 'devices.json');
  const seeded = {};
  for (let index = 0; index < 512; index++) {
    const request = identity(`credential-cap-${index}`, `cap${index}@example.com`);
    seeded[deviceProfileKey(request)] = official(`cap${index}@example.com`, `installation-cap-${index}`);
  }
  await writeFile(path, JSON.stringify(seeded), 'utf8');
  let calls = 0;
  const store = createAgDeviceProfiles({ path, generate: email => { calls++; return official(email, 'installation-over'); } });
  expect((await store.get(identity('credential-cap-0', 'cap0@example.com'))).installation_id).toBe('installation-cap-0');
  expect(calls).toBe(0);
  const error = await store.get(identity('credential-cap-over', 'overflow@example.com')).then(() => undefined, reason => reason);
  expect(error).toBeInstanceOf(AgDeviceStoreError);
  expect(error.code).toBe('full');
  expect(calls).toBe(0);
  const after = JSON.parse(await readFile(path, 'utf8'));
  expect(Object.keys(after).length).toBe(512);
});

test('an unusable identity is refused before the generator runs', async () => {
  const root = await tempRoot();
  let calls = 0;
  const store = createAgDeviceProfiles({ path: join(root, 'devices.json'), generate: email => { calls++; return official(email, 'unused'); } });
  for (const request of [{ credentialId: '', email: 'a@example.com' }, { credentialId: 'x', email: 'not-a-mailbox' },
    { credentialId: 'x', email: 'a@example.com\u0000' }, { email: 'a@example.com' }, null]) {
    const error = await store.get(request).then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(AgDeviceStoreError);
    expect(error.code).toBe('identity');
  }
  expect(calls).toBe(0);
});
