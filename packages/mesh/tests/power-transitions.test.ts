import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@godox-tl/core";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { __setNobleForTesting, MESH_PROXY_SERVICE_UUID } from "../src/ble/index.ts";
import type { NobleLike } from "../src/ble/noble.ts";
import { makeMeshController } from "../src/controller.ts";
import { k2 } from "../src/crypto/kdf.ts";
import { applicationNonce } from "../src/crypto/nonces.ts";
import { decodeUnsegmentedAccess } from "../src/pdu/lowerTransport.ts";
import { decodeNetworkPdu } from "../src/pdu/network.ts";
import { decodeProxyPdu } from "../src/pdu/proxy.ts";
import { decryptAccessPdu } from "../src/pdu/upperTransport.ts";
import { loadMeshState, saveMeshState, type MeshState } from "../src/state.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "godox-power-transitions-"));
});

afterEach(async () => {
  __setNobleForTesting(undefined);
  await rm(dir, { recursive: true, force: true });
});

const initialState: MeshState = {
  networkKey: new Uint8Array(16).fill(1),
  appKey: new Uint8Array(16).fill(2),
  deviceKey: new Uint8Array(16).fill(3),
  ivIndex: 0,
  provisionerAddress: 1,
  nodeAddress: 2,
  sequenceNumber: 7,
};

interface Frame {
  readonly sequence: number;
  readonly payload: Uint8Array;
}

const decodeFrame = (data: Buffer, state: MeshState): Frame => {
  const keys = k2(state.networkKey, Uint8Array.of(0));
  const network = decodeNetworkPdu({
    pdu: decodeProxyPdu(data).payload,
    ivIndex: state.ivIndex,
    ...keys,
  });
  const access = decryptAccessPdu({
    encryptedAccessPdu: decodeUnsegmentedAccess(network.lowerTransportPdu).encryptedAccessPdu,
    appKey: state.appKey,
    nonce: applicationNonce({ aszmic: 0, ...network, ivIndex: state.ivIndex }),
    szmic: 0,
  });
  return { sequence: network.seq, payload: access.subarray(3) };
};

class PowerNoble extends EventEmitter implements NobleLike {
  state = "poweredOn";
  connections = 0;
  disconnects = 0;
  meshState = initialState;
  readonly frames: Frame[] = [];

  constructor(private readonly onWrite?: (frame: Frame) => void) {
    super();
  }

  async startScanningAsync(): Promise<void> {
    const peripheral = {
      address: "AA:BB:CC:DD:EE:FF",
      state: "disconnected",
      advertisement: { serviceUuids: [MESH_PROXY_SERVICE_UUID] },
      connectAsync: async (): Promise<void> => {
        this.connections++;
        peripheral.state = "connected";
      },
      disconnectAsync: async (): Promise<void> => {
        this.disconnects++;
        peripheral.state = "disconnected";
      },
      discoverServicesAsync: async () => [
        {
          uuid: MESH_PROXY_SERVICE_UUID,
          discoverCharacteristicsAsync: async () => [
            {
              uuid: "2add",
              properties: ["writeWithoutResponse"],
              writeAsync: async (data: Buffer): Promise<void> => {
                const frame = decodeFrame(data, this.meshState);
                this.frames.push(frame);
                this.onWrite?.(frame);
              },
            },
          ],
        },
      ],
    };
    queueMicrotask(() => this.emit("discover", peripheral));
  }

  async stopScanningAsync(): Promise<void> {}
}

const activeCommands = [
  Domain.Cct.make({ brightness: Domain.pct(30), temperature: Domain.kelvin(4000) }),
  Domain.Hsi.make({ brightness: Domain.pct(30), hue: Domain.hue(120), saturation: Domain.sat(60) }),
  Domain.Rgbw.make({
    brightness: Domain.pct(30),
    red: Domain.byte(255),
    green: Domain.byte(0),
    blue: Domain.byte(0),
    white: Domain.byte(0),
  }),
  Domain.Fx.make({
    brightness: Domain.pct(30),
    effect: Domain.byte(2),
    subtype: Domain.byte(1),
    filter: Domain.byte(0),
  }),
];

test("power transitions repeat with distinct sequences before restoring every active mode", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, { ...initialState, sequenceDirectory: join(dir, "sequences") }),
  );
  const noble = new PowerNoble();
  __setNobleForTesting(noble);
  const controller = makeMeshController({ address: "AA:BB:CC:DD:EE:FF", statePath });

  for (const [index, command] of activeCommands.entries()) {
    const start = noble.frames.length;
    await Effect.runPromise(controller.send(Domain.Off.make({})));
    await Effect.runPromise(controller.send(command));
    await Effect.runPromise(controller.send(command));
    const frames = noble.frames.slice(start);
    expect(frames.map((frame) => frame.payload[0])).toEqual([
      0xfe,
      0xfe,
      0xfe,
      0xfe,
      0xf0 + index,
      0xf0 + index,
    ]);
    expect(frames.slice(0, 4).map((frame) => frame.payload[1])).toEqual([1, 1, 0, 0]);
    expect(frames[0]!.payload).toEqual(frames[1]!.payload);
    expect(frames[2]!.payload).toEqual(frames[3]!.payload);
  }
  expect(noble.frames.map((frame) => frame.sequence)).toEqual(
    Array.from({ length: 24 }, (_, index) => initialState.sequenceNumber + index),
  );
  expect((await Effect.runPromise(loadMeshState(statePath))).sequenceNumber).toBe(31);
  expect(noble.connections).toBe(1);
}, 15_000);

test("opening a new writer wakes again after an uncached send", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, { ...initialState, sequenceDirectory: join(dir, "sequences") }),
  );
  const noble = new PowerNoble();
  __setNobleForTesting(noble);
  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    connectionIdleMs: 0,
  });

  await Effect.runPromise(controller.send(activeCommands[0]!));
  await Effect.runPromise(controller.send(activeCommands[1]!));
  expect(noble.frames.map((frame) => frame.payload[0])).toEqual([
    0xfe, 0xfe, 0xf0, 0xfe, 0xfe, 0xf1,
  ]);
  expect(noble.connections).toBe(2);
  expect(noble.disconnects).toBe(2);
  expect((await Effect.runPromise(loadMeshState(statePath))).sequenceNumber).toBe(13);
}, 15_000);

test("a failed send leaves power unknown for the next attempt", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, { ...initialState, sequenceDirectory: join(dir, "sequences") }),
  );
  let failSettings = true;
  const noble = new PowerNoble((frame) => {
    if (failSettings && frame.payload[0] !== 0xfe) throw new Error("settings write failed");
  });
  __setNobleForTesting(noble);
  const controller = makeMeshController({ address: "AA:BB:CC:DD:EE:FF", statePath });
  const failed = await Effect.runPromiseExit(controller.send(activeCommands[0]!));
  expect(failed._tag).toBe("Failure");
  const beforeRecovery = noble.frames.length;
  const previousConnections = noble.connections;
  failSettings = false;

  await Effect.runPromise(controller.send(activeCommands[0]!));
  expect(noble.frames.slice(beforeRecovery).map((frame) => frame.payload[0])).toEqual([
    0xfe, 0xfe, 0xf0,
  ]);
  expect(noble.connections).toBe(previousConnections + 1);
  expect(new Set(noble.frames.map((frame) => frame.sequence)).size).toBe(noble.frames.length);
}, 15_000);

test("an Off from another controller invalidates warm power confidence under the source lease", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, { ...initialState, sequenceDirectory: join(dir, "sequences") }),
  );
  let powered = false;
  let settingsWhileOff = 0;
  const noble = new PowerNoble((frame) => {
    if (frame.payload[0] === 0xfe) powered = frame.payload[1] === 0;
    else if (!powered) settingsWhileOff++;
  });
  __setNobleForTesting(noble);
  const options = { address: "AA:BB:CC:DD:EE:FF", statePath };
  const warmController = makeMeshController(options);
  const otherController = makeMeshController(options);

  await Effect.runPromise(warmController.send(activeCommands[0]!));
  await Effect.runPromise(warmController.send(activeCommands[0]!));
  expect(noble.frames.map((frame) => frame.payload[0])).toEqual([0xfe, 0xfe, 0xf0, 0xf0]);
  await Effect.runPromise(otherController.send(Domain.Off.make({})));
  expect(powered).toBe(false);
  const beforeRestore = noble.frames.length;

  await Effect.runPromise(warmController.send(activeCommands[0]!));
  expect(noble.frames.slice(beforeRestore).map((frame) => frame.payload[0])).toEqual([
    0xfe, 0xfe, 0xf0,
  ]);
  expect(powered).toBe(true);
  expect(settingsWhileOff).toBe(0);
  // Both controllers retain their own connected writer: source activity, not a
  // reconnect, must trigger the extra wake on the first controller.
  expect(noble.connections).toBe(2);
  expect(noble.frames.map((frame) => frame.sequence)).toEqual(
    Array.from({ length: 9 }, (_, index) => initialState.sequenceNumber + index),
  );
}, 15_000);

test("a changed IV index invalidates confidence even when the next sequence number matches", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, { ...initialState, sequenceDirectory: join(dir, "sequences") }),
  );
  const noble = new PowerNoble();
  __setNobleForTesting(noble);
  const controller = makeMeshController({ address: "AA:BB:CC:DD:EE:FF", statePath });
  await Effect.runPromise(controller.send(activeCommands[0]!));
  const previous = await Effect.runPromise(loadMeshState(statePath));
  const changed = { ...previous, ivIndex: previous.ivIndex + 1 };
  await Effect.runPromise(saveMeshState(statePath, changed));
  noble.meshState = changed;
  const beforeRestore = noble.frames.length;

  await Effect.runPromise(controller.send(activeCommands[0]!));
  expect(noble.frames.slice(beforeRestore).map((frame) => frame.payload[0])).toEqual([
    0xfe, 0xfe, 0xf0,
  ]);
  expect(noble.frames[beforeRestore]!.sequence).toBe(previous.sequenceNumber);
  expect(noble.connections).toBe(1);
}, 15_000);
