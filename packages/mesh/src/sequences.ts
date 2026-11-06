import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { loadMeshState, MeshStateError, saveMeshState, type MeshState } from "./state.ts";

const MAX_SEQUENCE = 0xff_ffff;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 10;

export interface SequenceOptions {
  /** Shared writable directory for every process controlling this mesh. Persisted in light states. */
  readonly sequenceDirectory?: string;
  /** Move an existing store after stopping other controllers. */
  readonly migrateSequenceDirectory?: boolean;
  /** Other registered state files to include when migrating legacy counters. */
  readonly statePaths?: ReadonlyArray<string>;
  readonly statePath?: string;
  readonly lockTimeoutMs?: number;
}

export interface SequenceReservation {
  readonly sequenceNumber: number;
  readonly nextSequenceNumber: number;
  readonly sequenceDirectory: string;
}

interface Counter {
  readonly version: 1;
  readonly ivIndex: number;
  readonly nextSequenceNumber: number;
  readonly statePaths: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const integer = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;

const parseCounter = (text: string): Counter => {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !integer(value["ivIndex"], 0xffff_ffff) ||
    !integer(value["nextSequenceNumber"], MAX_SEQUENCE + 1) ||
    !Array.isArray(value["statePaths"]) ||
    !value["statePaths"].every((path: unknown) => typeof path === "string")
  ) {
    throw new Error("invalid mesh sequence counter; refusing to reset it");
  }
  return {
    version: 1,
    ivIndex: value["ivIndex"],
    nextSequenceNumber: value["nextSequenceNumber"],
    statePaths: value["statePaths"],
  };
};

const errorCode = (error: unknown): unknown => (isRecord(error) ? error["code"] : undefined);

const readCounter = async (path: string): Promise<Counter | undefined> => {
  try {
    return parseCounter(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
};

interface LockEntry {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  /** Zero is Lamport's choosing phase; positive values are published tickets. */
  readonly ticket: number;
}

const ownerIsAlive = (owner: LockEntry): boolean => {
  // A shared filesystem across hosts needs a distributed lock, not local PID checks.
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
};

const readOwner = async (path: string, checkWaiting: () => void): Promise<string> => {
  while (true) {
    checkWaiting();
    try {
      return await readlink(path);
    } catch (error) {
      // On macOS readlink can report EINVAL while rename atomically replaces
      // a symlink. Retry the same participant; skipping it would break exclusion.
      if (errorCode(error) !== "EINVAL" || !(await lstat(path)).isSymbolicLink()) throw error;
    }
  }
};

const lockEntries = async (path: string, checkWaiting: () => void): Promise<LockEntry[]> => {
  const entries: LockEntry[] = [];
  for (const token of await readdir(path)) {
    try {
      const owner: unknown = JSON.parse(await readOwner(join(path, token), checkWaiting));
      if (
        !isRecord(owner) ||
        !integer(owner["pid"], 0x7fff_ffff) ||
        owner["pid"] === 0 ||
        typeof owner["host"] !== "string" ||
        owner["token"] !== token ||
        !integer(owner["ticket"], Number.MAX_SAFE_INTEGER)
      )
        throw new Error("invalid mesh sequence lock owner");
      const entry: LockEntry = {
        pid: owner["pid"],
        host: owner["host"],
        token,
        ticket: owner["ticket"],
      };
      if (ownerIsAlive(entry)) entries.push(entry);
      else await unlink(join(path, token));
    } catch (error) {
      // UUID names are never reused, so a vanished entry cannot be a new owner.
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return entries;
};

/** Lamport bakery lock with dynamically registered, never-reused participants.
 * A chooser publishes its unique owner before observing existing tickets. Other
 * entrants wait for choosing participants as well as lower (ticket, UUID) pairs.
 * This also covers a chooser paused before publishing its final ticket. Every
 * entry is an atomic symlink containing its owner, including during replacement.
 * Only dead local processes are reaped; a paused live owner never loses its lock.
 */
const acquireCounterLock = async (
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<() => Promise<void>> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const ownPath = join(path, token);
  // Stage outside the participant directory, so every listed participant is
  // always readable even while its choosing entry is replaced atomically.
  const temporary = `${path}.${token}.tmp`;
  const owner = { pid: process.pid, host: hostname(), token };
  let published = false;
  let acquired = false;
  const checkWaiting = (): void => {
    signal.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error(`mesh sequence lock timed out after ${timeoutMs}ms: ${path}`);
  };
  try {
    checkWaiting();
    await symlink(JSON.stringify({ ...owner, ticket: 0 }), ownPath);
    published = true;
    const ticket =
      Math.max(0, ...(await lockEntries(path, checkWaiting)).map((entry) => entry.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error("mesh sequence lock ticket overflow");
    checkWaiting();
    await symlink(JSON.stringify({ ...owner, ticket }), temporary);
    await rename(temporary, ownPath);
    while (true) {
      checkWaiting();
      const waiting = (await lockEntries(path, checkWaiting)).some(
        (entry) =>
          entry.token !== token &&
          (entry.ticket === 0 ||
            entry.ticket < ticket ||
            (entry.ticket === ticket && entry.token < token)),
      );
      if (!waiting) {
        acquired = true;
        return () => unlink(ownPath);
      }
      await new Promise<void>((done) => setTimeout(done, LOCK_POLL_MS));
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    if (published && !acquired) await unlink(ownPath);
  }
};

const sameSource = (a: MeshState, b: MeshState): boolean =>
  a.provisionerAddress === b.provisionerAddress && Buffer.from(a.networkKey).equals(b.networkKey);

const canonicalStatePath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // A new state may not exist yet, but its parent can itself be a symlink.
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch (parentError) {
      if (errorCode(parentError) !== "ENOENT") throw parentError;
      return resolve(path);
    }
  }
};

const legacyPaths = async (options: SequenceOptions): Promise<string[]> => {
  const paths = new Set(await Promise.all((options.statePaths ?? []).map(canonicalStatePath)));
  if (options.statePath) {
    const currentPath = await canonicalStatePath(options.statePath);
    paths.add(currentPath);
    for (const entry of await readdir(dirname(currentPath))) {
      if (entry.endsWith(".json"))
        paths.add(await canonicalStatePath(join(dirname(currentPath), entry)));
    }
  }
  return [...paths];
};

const legacyState = async (path: string): Promise<MeshState | undefined> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw["network_key"] === undefined) return undefined;
  return Effect.runPromise(loadMeshState(path));
};

const pointerDirectory = async (path: string): Promise<string | undefined> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value["version"] !== 1 || typeof value["directory"] !== "string") {
    throw new Error(`invalid mesh sequence store pointer: ${path}`);
  }
  return resolve(value["directory"]);
};

interface SequenceLease extends SequenceReservation {
  readonly release: () => Promise<void>;
}

const acquireReservation = async (
  state: MeshState,
  count: number,
  options: SequenceOptions,
  signal: AbortSignal,
): Promise<SequenceLease> => {
  if (
    !integer(state.sequenceNumber, MAX_SEQUENCE + 1) ||
    !integer(state.ivIndex, 0xffff_ffff) ||
    !integer(state.provisionerAddress, 0x7fff) ||
    state.provisionerAddress === 0 ||
    state.networkKey.length !== 16 ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    throw new Error("invalid mesh sequence reservation");
  }
  if (options.migrateSequenceDirectory && !options.sequenceDirectory)
    throw new Error("store migration requires an explicit sequenceDirectory");
  const requestedDirectory = resolve(
    options.sequenceDirectory ??
      state.sequenceDirectory ??
      process.env["GODOX_TL_SEQUENCE_DIRECTORY"] ??
      join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "godox-tl", "sequences"),
  );
  const identity = createHash("sha256")
    .update(state.networkKey)
    .update(`:${state.provisionerAddress}`)
    .digest("hex");
  const timeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new Error("lockTimeoutMs must be finite and nonnegative");
  const deadline = Date.now() + timeoutMs;
  const takeLock = (path: string): Promise<() => Promise<void>> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`mesh sequence lock timed out after ${timeoutMs}ms`);
    return acquireCounterLock(path, remaining, signal);
  };
  const statePath = options.statePath ? await canonicalStatePath(options.statePath) : undefined;
  const knownPaths = new Set<string>();
  for (const path of await legacyPaths(options)) {
    const peer = await legacyState(path);
    if (peer && sameSource(state, peer)) knownPaths.add(path);
  }
  while (true) {
    const releases: Array<() => Promise<void>> = [];
    const release = async (): Promise<void> => {
      const results = await Promise.allSettled(
        releases
          .splice(0)
          .reverse()
          .map((unlock) => unlock()),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
    try {
      // All known state paths participate in bootstrap. A CLI selecting just
      // one of those states shares at least that lock with Homebridge.
      const pointers = [...knownPaths].sort().map((path) => `${path}.sequence-${identity}`);
      for (const pointer of pointers) releases.push(await takeLock(`${pointer}.locks`));
      const stores = new Set<string>();
      const hints = new Set<string>();
      for (const pointer of pointers) {
        const directory = await pointerDirectory(pointer);
        if (directory) stores.add(directory);
      }
      const peers = new Map<string, MeshState>();
      for (const path of knownPaths) {
        const peer = await legacyState(path);
        if (peer && sameSource(state, peer)) {
          peers.set(path, peer);
          if (peer.sequenceDirectory) hints.add(resolve(peer.sequenceDirectory));
        }
      }
      if (state.sequenceDirectory) hints.add(resolve(state.sequenceDirectory));
      if (stores.size > 1 && !options.migrateSequenceDirectory)
        throw new Error(
          "mesh states point to conflicting sequence stores; explicit migration is required",
        );
      if (stores.size === 0 && hints.size > 1 && !options.migrateSequenceDirectory)
        throw new Error(
          "mesh states use conflicting sequence stores; explicit migration is required",
        );
      const directory = options.migrateSequenceDirectory
        ? requestedDirectory
        : ([...stores][0] ?? [...hints][0] ?? requestedDirectory);
      const priorDirectories = new Set([directory, ...stores, ...hints]);
      // The pointer wins over per-process defaults, including simultaneous
      // first use of a legacy state by different Homebridge/CLI users.
      let discovered = false;
      for (const prior of priorDirectories) {
        const counter = await readCounter(join(prior, `${identity}.json`));
        for (const storedPath of counter?.statePaths ?? []) {
          const path = await canonicalStatePath(storedPath);
          const peer = await legacyState(path);
          if (peer && sameSource(state, peer) && !knownPaths.has(path)) {
            knownPaths.add(path);
            discovered = true;
          }
        }
      }
      if (discovered) {
        await release();
        continue;
      }
      for (const prior of [...priorDirectories].sort()) {
        await mkdir(prior, { recursive: true, mode: 0o700 });
        releases.push(await takeLock(join(prior, `${identity}.json.locks`)));
      }
      let next = state.sequenceNumber;
      for (const prior of priorDirectories) {
        const counter = await readCounter(join(prior, `${identity}.json`));
        if (counter && counter.ivIndex > state.ivIndex)
          throw new Error("light state IV index is older than the shared mesh counter");
        if (counter?.ivIndex === state.ivIndex) next = Math.max(next, counter.nextSequenceNumber);
        for (const storedPath of counter?.statePaths ?? []) {
          const path = await canonicalStatePath(storedPath);
          const peer = await legacyState(path);
          if (peer && sameSource(state, peer) && !knownPaths.has(path)) {
            knownPaths.add(path);
            discovered = true;
          }
        }
      }
      if (discovered) {
        await release();
        continue;
      }
      for (const [path, peer] of peers) {
        if (peer.ivIndex > state.ivIndex)
          throw new Error(`mesh state has a newer IV index: ${path}`);
        if (peer.ivIndex === state.ivIndex) {
          if (!integer(peer.sequenceNumber, MAX_SEQUENCE + 1))
            throw new Error(`invalid legacy sequence counter: ${path}`);
          next = Math.max(next, peer.sequenceNumber);
        }
      }
      if (next + count > MAX_SEQUENCE + 1)
        throw new Error("mesh sequence numbers exhausted; an IV update is required");
      const reservation = {
        sequenceNumber: next,
        nextSequenceNumber: next + count,
        sequenceDirectory: directory,
      };
      const counter: Counter = {
        version: 1,
        ivIndex: state.ivIndex,
        nextSequenceNumber: reservation.nextSequenceNumber,
        statePaths: [...knownPaths],
      };
      await writeJson(join(directory, `${identity}.json`), counter);
      for (const pointer of pointers) {
        if ((await pointerDirectory(pointer)) !== directory)
          await writeJson(pointer, { version: 1, directory });
      }
      if (statePath)
        await Effect.runPromise(
          saveMeshState(statePath, {
            ...state,
            deviceAddress: state.deviceAddress ?? peers.get(statePath)?.deviceAddress,
            sequenceNumber: reservation.nextSequenceNumber,
            sequenceDirectory: directory,
          }),
        );
      return { ...reservation, release };
    } catch (error) {
      await release();
      throw error;
    }
  }
};

/** Persist a reservation before use and hold the source lock through transmission.
 * Configuration messages and control messages use this same lease, preventing a
 * later process from sending its higher sequence before this block is delivered.
 */
export const withMeshSequenceReservation = <A, E, R>(
  state: MeshState,
  count: number,
  options: SequenceOptions,
  use: (reservation: SequenceReservation) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MeshStateError, R> =>
  Effect.suspend(() => {
    const abort = new AbortController();
    let pending: Promise<SequenceLease> | undefined;
    let lease: SequenceLease | undefined;
    const acquire = Effect.tryPromise({
      try: (signal) => {
        const onAbort = (): void => abort.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        pending = acquireReservation(state, count, options, abort.signal)
          .then((value) => {
            lease = value;
            return value;
          })
          .finally(() => signal.removeEventListener("abort", onAbort));
        return pending;
      },
      catch: (cause) =>
        new MeshStateError({
          path: options.statePath,
          message: `failed to reserve mesh sequence numbers: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
    const release = Effect.promise(async () => {
      abort.abort();
      // A cancelled Promise may still be completing a durable write. Wait for
      // its own cleanup/result before releasing any lease it managed to obtain.
      await pending?.catch(() => undefined);
      if (lease) await lease.release();
    });
    return Effect.scoped(
      Effect.acquireReleaseInterruptible(acquire, () => release).pipe(Effect.flatMap(use)),
    );
  });

/** Reserve a block without sending it. Use withMeshSequenceReservation for BLE
 * traffic so allocation and transmission are serialized together.
 */
export const reserveMeshSequences = (
  state: MeshState,
  count: number,
  options: SequenceOptions = {},
): Effect.Effect<SequenceReservation, MeshStateError> =>
  withMeshSequenceReservation(state, count, options, (reservation) =>
    Effect.succeed({
      sequenceNumber: reservation.sequenceNumber,
      nextSequenceNumber: reservation.nextSequenceNumber,
      sequenceDirectory: reservation.sequenceDirectory,
    }),
  );
