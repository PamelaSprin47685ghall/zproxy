// Persist one official Antigravity device profile per credential identity.
//
// The file carries device fields only: no token, no mailbox, and no credential
// id. Each entry is keyed by a SHA-256 of the identity; keys are linkable if
// the identity is known. The six fields and their order
// are the Go antigravity.Device JSON encoding, so a file a previous install
// seeded with official profiles is adopted as it stands.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Field order of the official Go antigravity.Device JSON encoding. */
const FIELDS = ['os', 'arch', 'user_name', 'app_data_dir', 'time_zone', 'installation_id'];
/** Per-field byte limits. A real device stays far below every one of them. */
const FIELD_BYTES = { os: 64, arch: 64, user_name: 256, app_data_dir: 512, time_zone: 128, installation_id: 128 };
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_ID_BYTES = 256;
const MAX_MAILBOX_BYTES = 320;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const HASHED_KEY = /^[0-9a-f]{64}$/u;
const MAILBOX = /^[^@\s]+@[^@\s]+$/u;
const IDENTITY_DOMAIN = 'zproxy-ag-device-v1';

const MESSAGES = {
  identity: 'The Antigravity device identity is invalid.',
  invalid: 'The Antigravity device profile is invalid.',
  corrupt: 'The Antigravity device store is corrupt.',
  unreadable: 'The Antigravity device store cannot be read.',
  oversized: 'The Antigravity device store exceeds its limits.',
  full: 'The Antigravity device store is full.',
  write: 'The Antigravity device store cannot be written.',
  generate: 'The Antigravity device profile could not be generated.',
};

/**
 * A device-store failure with a stable code.
 *
 * Message, code, and operation are fixed strings, and the original error is not
 * kept as a cause. A filesystem error names the store path, and a path can carry
 * a user name, a mailbox, or a credential; none of that may reach a log.
 */
export class AgDeviceStoreError extends Error {
  constructor(code, operation) {
    const known = Object.hasOwn(MESSAGES, code);
    super(known ? MESSAGES[code] : MESSAGES.unreadable);
    this.name = 'AgDeviceStoreError';
    this.code = known ? code : 'unreadable';
    this.operation = operation;
  }
}

function normalizedId(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalize one credential identity into its store key and its mailbox. */
function identity(request, operation) {
  const input = request && typeof request === 'object' ? request : {};
  const id = normalizedId(input.credentialId);
  if (id === '' || Buffer.byteLength(id) > MAX_ID_BYTES || CONTROL.test(id)) {
    throw new AgDeviceStoreError('identity', operation);
  }
  const mailbox = typeof input.email === 'string' ? input.email.trim() : '';
  if (Buffer.byteLength(mailbox) > MAX_MAILBOX_BYTES || CONTROL.test(mailbox) || !MAILBOX.test(mailbox)) {
    throw new AgDeviceStoreError('identity', operation);
  }
  const key = createHash('sha256').update(JSON.stringify([IDENTITY_DOMAIN, id, mailbox.toLowerCase()])).digest('hex');
  return { key, mailbox };
}

/** Derive the stable store key of one credential identity without touching disk. */
export function deviceProfileKey(request) {
  return identity(request, 'key').key;
}

/**
 * Project a value onto the official device shape.
 *
 * Exactly the six official fields survive, in official order, so a generator
 * that returns more cannot leak an account field or a token into the file.
 * Stored profiles must already include the account-specific fields.
 */
function deviceProfile(value, operation, filled) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgDeviceStoreError('invalid', operation);
  const device = {};
  for (const field of FIELDS) {
    const text = value[field];
    if (typeof text !== 'string' || Buffer.byteLength(text) > FIELD_BYTES[field] || CONTROL.test(text)) {
      throw new AgDeviceStoreError('invalid', operation);
    }
    if (filled && text === '') throw new AgDeviceStoreError('invalid', operation);
    device[field] = text;
  }
  return device;
}

const frozen = device => Object.freeze({ ...device });

/**
 * Read the whole store.
 *
 * A missing file is an empty store. A corrupt, oversized, or unreadable one is a
 * failure with its own code: rebuilding it would replace devices the upstream
 * already saw, and dropping an unrecognized entry would lose the data silently.
 */
async function readStore(path) {
  let text;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new AgDeviceStoreError('unreadable', 'load');
    if (info.size > MAX_FILE_BYTES) throw new AgDeviceStoreError('oversized', 'load');
    // A seeded file may arrive world-readable. Tightening it here keeps device
    // fields private even when no write follows; another owner's file stays as
    // it is, because only its own permissions can be changed.
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof AgDeviceStoreError) throw error;
    if (error?.code === 'ENOENT') return new Map();
    throw new AgDeviceStoreError('unreadable', 'load');
  }
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new AgDeviceStoreError('oversized', 'load');
  if (text.trim() === '') return new Map();
  let root;
  try { root = JSON.parse(text); } catch { throw new AgDeviceStoreError('corrupt', 'load'); }
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new AgDeviceStoreError('corrupt', 'load');
  const devices = new Map();
  for (const [key, value] of Object.entries(root)) {
    // Only a canonical derived key belongs here. Anything else is a foreign or
    // malformed entry, and guessing at it could serve the wrong device.
    if (!HASHED_KEY.test(key)) throw new AgDeviceStoreError('corrupt', 'load');
    devices.set(key, deviceProfile(value, 'load', true));
  }
  if (devices.size > MAX_ENTRIES) throw new AgDeviceStoreError('oversized', 'load');
  return devices;
}

function encode(devices) {
  const entries = [...devices.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

/**
 * Make the store directory exist.
 *
 * Only a directory this store creates is tightened to 0700. An existing
 * directory may hold other files, and changing its mode would reach beyond this
 * store; the file itself is always created private.
 */
async function ensureDirectory(directory) {
  try {
    if (!(await stat(directory)).isDirectory()) throw new AgDeviceStoreError('write', 'save');
    return;
  } catch (error) {
    if (error instanceof AgDeviceStoreError) throw error;
    if (error?.code !== 'ENOENT') throw new AgDeviceStoreError('write', 'save');
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } catch { throw new AgDeviceStoreError('write', 'save'); }
}

/** Replace the store atomically: one private temporary file, then one rename. */
async function writeStore(path, devices) {
  const body = encode(devices);
  if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new AgDeviceStoreError('full', 'save');
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error instanceof AgDeviceStoreError) throw error;
    throw new AgDeviceStoreError('write', 'save');
  }
}

/**
 * Open the persistent device-profile store.
 *
 * generate is the official device factory: it receives the trimmed mailbox
 * and resolves the Go antigravity.Device JSON shape. One profile is created per
 * identity, written atomically before it is returned, and never cached after a
 * failed write, so a retry cannot serve a profile that the disk lost.
 */
export function createAgDeviceProfiles({ path, generate } = {}) {
  if (typeof path !== 'string' || path.trim() === '' || CONTROL.test(path)) {
    throw new TypeError('An Antigravity device store needs a valid file path.');
  }
  if (typeof generate !== 'function') throw new TypeError('An Antigravity device generator is required.');
  const storePath = resolve(path);
  if (dirname(storePath) === storePath) throw new TypeError('An Antigravity device store needs a private directory.');
  let devices;
  let loading;
  let queue = Promise.resolve();
  const pending = new Map();

  const current = () => {
    if (devices) return Promise.resolve(devices);
    loading ??= readStore(storePath).then(next => {
      devices = next;
      return next;
    }).finally(() => { loading = undefined; });
    return loading;
  };

  // Every write runs alone and starts from the state the previous write left.
  const serialize = task => {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const generateDevice = async mailbox => {
    try { return deviceProfile(await generate(mailbox), 'generate', true); }
    catch (error) {
      if (error instanceof AgDeviceStoreError) throw error;
      throw new AgDeviceStoreError('generate', 'generate');
    }
  };

  const create = async (key, mailbox) => {
    const saved = (await current()).get(key);
    if (saved) return frozen(saved);
    // A full store refuses the identity before the official factory runs, so a
    // rejected lookup costs no upstream device call.
    if (devices.size >= MAX_ENTRIES) throw new AgDeviceStoreError('full', 'save');
    // Generation runs outside the write queue, so distinct identities do not
    // wait for one official device call. The lock covers the compare and write.
    const generated = await generateDevice(mailbox);
    return serialize(async () => {
      const latest = devices;
      const existing = latest.get(key);
      if (existing) return frozen(existing);
      if (latest.size >= MAX_ENTRIES) throw new AgDeviceStoreError('full', 'save');
      const next = new Map(latest);
      next.set(key, generated);
      await writeStore(storePath, next);
      devices = next;
      return frozen(generated);
    });
  };

  /** Resolve the persistent device profile of one credential identity. */
  async function get(request) {
    const { key, mailbox } = identity(request, 'get');
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const task = create(key, mailbox).finally(() => { pending.delete(key); });
    pending.set(key, task);
    return task;
  }

  return { get };
}
