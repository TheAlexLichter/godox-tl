import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@godox-tl/core";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { __setNobleForTesting, MESH_PROXY_SERVICE_UUID } from "../src/ble/index.ts";
import type { NobleLike, PeripheralLike } from "../src/ble/noble.ts";
import { makeMeshController } from "../src/controller.ts";
import { k2 } from "../src/crypto/kdf.ts";
import { applicationNonce } from "../src/crypto/nonces.ts";
import { decodeUnsegmentedAccess } from "../src/pdu/lowerTransport.ts";
import { decodeNetworkPdu } from "../src/pdu/network.ts";
import { decodeProxyPdu } from "../src/pdu/proxy.ts";
import { decryptAccessPdu } from "../src/pdu/upperTransport.ts";
import { loadMeshState, saveMeshState, type MeshState } from "../src/state.ts";

const { Cct, kelvin, pct } = Domain;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "godox-mesh-controller-"));
});

afterEach(async () => {
  __setNobleForTesting(undefined);
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const sampleState = (sequenceNumber: number): MeshState => ({
  networkKey: new Uint8Array([
    0x3a, 0x21, 0xd5, 0xa9, 0x4e, 0x7f, 0x3f, 0x05, 0x56, 0x88, 0x1d, 0xc1, 0xe8, 0xd1, 0xbc, 0x8d,
  ]),
  appKey: new Uint8Array([
    0xde, 0xf7, 0x05, 0xc8, 0xb7, 0x5b, 0x70, 0xcf, 0x9b, 0x54, 0xa5, 0x93, 0xc4, 0xe7, 0x1e, 0x16,
  ]),
  deviceKey: new Uint8Array([
    0xbf, 0x0e, 0xa7, 0x57, 0x41, 0xf2, 0x23, 0x0e, 0x2a, 0x90, 0x05, 0xeb, 0x06, 0xff, 0xf2, 0x72,
  ]),
  ivIndex: 0,
  provisionerAddress: 1,
  nodeAddress: 2,
  sequenceNumber,
});

class FakeCharacteristic extends EventEmitter {
  readonly properties = ["writeWithoutResponse"];

  constructor(
    readonly uuid: string,
    private readonly onWrite?: (data: Buffer) => Promise<void>,
  ) {
    super();
  }

  async writeAsync(data: Buffer): Promise<void> {
    await this.onWrite?.(data);
  }

  async subscribeAsync(): Promise<void> {}

  async unsubscribeAsync(): Promise<void> {}
}

class FakeService {
  readonly uuid = MESH_PROXY_SERVICE_UUID;

  constructor(private readonly onWrite?: (data: Buffer) => Promise<void>) {}

  async discoverCharacteristicsAsync(): Promise<FakeCharacteristic[]> {
    return [
      new FakeCharacteristic(
        "2add",
        this.onWrite ??
          (async () => {
            await chmod(dir, 0o500);
          }),
      ),
      new FakeCharacteristic("2ade"),
    ];
  }
}

class FakeNoble extends EventEmitter implements NobleLike {
  state = "poweredOn";

  constructor(private readonly onWrite?: (data: Buffer) => Promise<void>) {
    super();
  }

  async startScanningAsync(): Promise<void> {
    const peripheral: PeripheralLike & {
      connectAsync: () => Promise<void>;
      disconnectAsync: () => Promise<void>;
      discoverServicesAsync: () => Promise<FakeService[]>;
    } = {
      id: "aabbccddeeff",
      uuid: "aabbccddeeff",
      address: "AA:BB:CC:DD:EE:FF",
      advertisement: { localName: "GD_LED", serviceUuids: [MESH_PROXY_SERVICE_UUID] },
      connectAsync: async () => {},
      disconnectAsync: async () => {},
      discoverServicesAsync: async () => [new FakeService(this.onWrite)],
    };
    queueMicrotask(() => this.emit("discover", peripheral));
  }

  async stopScanningAsync(): Promise<void> {}
}

test("mesh controller reserves the next sequence number before writing to BLE", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(saveMeshState(statePath, sampleState(7)));
  __setNobleForTesting(new FakeNoble());

  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
  });
  await Effect.runPromise(
    controller.send(Cct.make({ brightness: pct(50), temperature: kelvin(4500) })),
  );

  const raw = JSON.parse(await readFile(statePath, "utf8")) as { sequence_number: number };
  expect(raw.sequence_number).toBe(9);
});

test("mesh controller wakes a soft-off fixture before restoring its brightness and color", async () => {
  const statePath = join(dir, "state.json");
  const initial = sampleState(7);
  await Effect.runPromise(saveMeshState(statePath, initial));
  const { encryptionKey, privacyKey } = k2(initial.networkKey, Uint8Array.of(0));
  let powered = true;
  let brightness = 0;
  const sequences: number[] = [];

  __setNobleForTesting(
    new FakeNoble(async (data) => {
      const network = decodeNetworkPdu({
        pdu: decodeProxyPdu(data).payload,
        ivIndex: initial.ivIndex,
        encryptionKey,
        privacyKey,
      });
      const access = decryptAccessPdu({
        encryptedAccessPdu: decodeUnsegmentedAccess(network.lowerTransportPdu).encryptedAccessPdu,
        appKey: initial.appKey,
        nonce: applicationNonce({ aszmic: 0, ...network, ivIndex: initial.ivIndex }),
        szmic: 0,
      });
      sequences.push(network.seq);
      const payload = access.subarray(3);
      if (payload[0] === 0xfe) powered = payload[1] === 0;
      else {
        expect(powered).toBe(true);
        brightness = payload[1]!;
      }
    }),
  );
  const controller = makeMeshController({ address: "AA:BB:CC:DD:EE:FF", statePath });
  await Effect.runPromise(controller.send(Domain.Off.make({})));
  expect(powered).toBe(false);
  await Effect.runPromise(
    controller.send(Cct.make({ brightness: pct(30), temperature: kelvin(4000) })),
  );
  expect(powered).toBe(true);
  expect(brightness).toBe(30);
  expect(sequences).toEqual([7, 8, 9]);
  expect((await Effect.runPromise(loadMeshState(statePath))).sequenceNumber).toBe(10);
});

test("mesh controller serializes concurrent sends so each command reserves a unique sequence number", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(saveMeshState(statePath, sampleState(7)));

  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    dryRun: true,
  });

  await Promise.all(
    Array.from({ length: 8 }, () =>
      Effect.runPromise(
        controller.send(Cct.make({ brightness: pct(50), temperature: kelvin(4500) })),
      ),
    ),
  );

  const state = await Effect.runPromise(loadMeshState(statePath));
  expect(state.sequenceNumber).toBe(23);
});

test("mesh controller coalesces queued sends and reuses a warm proxy writer", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(saveMeshState(statePath, sampleState(7)));

  let releaseFirstWrite: (() => void) | undefined;
  let firstWriteStarted: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const firstWriteSignal = new Promise<void>((resolve) => {
    firstWriteStarted = resolve;
  });

  let writeCount = 0;
  let connectCount = 0;

  class CoalesceCharacteristic extends EventEmitter {
    readonly properties = ["writeWithoutResponse"];

    constructor(readonly uuid: string) {
      super();
    }

    async writeAsync(): Promise<void> {
      writeCount++;
      if (writeCount === 1) {
        firstWriteStarted?.();
        await firstWrite;
      }
    }
  }

  class CoalesceService {
    readonly uuid = MESH_PROXY_SERVICE_UUID;

    async discoverCharacteristicsAsync(): Promise<CoalesceCharacteristic[]> {
      return [new CoalesceCharacteristic("2add")];
    }
  }

  class CoalesceNoble extends EventEmitter implements NobleLike {
    state = "poweredOn";

    async startScanningAsync(): Promise<void> {
      const peripheral: PeripheralLike & {
        connectAsync: () => Promise<void>;
        disconnectAsync: () => Promise<void>;
        discoverServicesAsync: () => Promise<CoalesceService[]>;
      } = {
        id: "aabbccddeeff",
        uuid: "aabbccddeeff",
        address: "AA:BB:CC:DD:EE:FF",
        advertisement: { localName: "GD_LED", serviceUuids: [MESH_PROXY_SERVICE_UUID] },
        connectAsync: async () => {
          connectCount++;
        },
        disconnectAsync: async () => {},
        discoverServicesAsync: async () => [new CoalesceService()],
      };
      queueMicrotask(() => this.emit("discover", peripheral));
    }

    async stopScanningAsync(): Promise<void> {}
  }

  __setNobleForTesting(new CoalesceNoble());
  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    connectionIdleMs: 10_000,
  });

  const first = Effect.runPromise(
    controller.send(Cct.make({ brightness: pct(10), temperature: kelvin(3200) })),
  );
  await firstWriteSignal;

  const second = Effect.runPromise(
    controller.send(Cct.make({ brightness: pct(20), temperature: kelvin(4500) })),
  );
  const third = Effect.runPromise(
    controller.send(Cct.make({ brightness: pct(30), temperature: kelvin(5600) })),
  );

  releaseFirstWrite?.();
  await Promise.all([first, second, third]);

  const state = await Effect.runPromise(loadMeshState(statePath));
  expect(state.sequenceNumber).toBe(11);
  expect(writeCount).toBe(4);
  expect(connectCount).toBe(1);
});

test("mesh controller serializes queued sends when coalescing is disabled", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(saveMeshState(statePath, sampleState(7)));

  let releaseFirstWrite: (() => void) | undefined;
  let firstWriteStarted: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const firstWriteSignal = new Promise<void>((resolve) => {
    firstWriteStarted = resolve;
  });

  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  let writeCount = 0;
  let connectCount = 0;

  class SerialCharacteristic extends EventEmitter {
    readonly properties = ["writeWithoutResponse"];

    constructor(readonly uuid: string) {
      super();
    }

    async writeAsync(): Promise<void> {
      activeWrites++;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      writeCount++;
      try {
        if (writeCount === 1) {
          firstWriteStarted?.();
          await firstWrite;
        }
      } finally {
        activeWrites--;
      }
    }
  }

  class SerialService {
    readonly uuid = MESH_PROXY_SERVICE_UUID;

    async discoverCharacteristicsAsync(): Promise<SerialCharacteristic[]> {
      return [new SerialCharacteristic("2add")];
    }
  }

  class SerialNoble extends EventEmitter implements NobleLike {
    state = "poweredOn";

    async startScanningAsync(): Promise<void> {
      const peripheral: PeripheralLike & {
        connectAsync: () => Promise<void>;
        disconnectAsync: () => Promise<void>;
        discoverServicesAsync: () => Promise<SerialService[]>;
      } = {
        id: "aabbccddeeff",
        uuid: "aabbccddeeff",
        address: "AA:BB:CC:DD:EE:FF",
        advertisement: { localName: "GD_LED", serviceUuids: [MESH_PROXY_SERVICE_UUID] },
        connectAsync: async () => {
          connectCount++;
        },
        disconnectAsync: async () => {},
        discoverServicesAsync: async () => [new SerialService()],
      };
      queueMicrotask(() => this.emit("discover", peripheral));
    }

    async stopScanningAsync(): Promise<void> {}
  }

  __setNobleForTesting(new SerialNoble());
  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    coalesce: false,
    connectionIdleMs: 10_000,
  });

  const first = Effect.runPromise(
    controller.send(Cct.make({ brightness: pct(10), temperature: kelvin(3200) })),
  );
  await firstWriteSignal;

  const second = Effect.runPromise(
    controller.send(Cct.make({ brightness: pct(20), temperature: kelvin(4500) })),
  );
  const third = Effect.runPromise(
    controller.send(Cct.make({ brightness: pct(30), temperature: kelvin(5600) })),
  );

  await new Promise((resolve) => setTimeout(resolve, 250));
  const writeCountBeforeRelease = writeCount;
  const maxConcurrentWritesBeforeRelease = maxConcurrentWrites;

  releaseFirstWrite?.();
  await Promise.all([first, second, third]);

  const state = await Effect.runPromise(loadMeshState(statePath));
  expect(writeCountBeforeRelease).toBe(1);
  expect(maxConcurrentWritesBeforeRelease).toBe(1);
  expect(state.sequenceNumber).toBe(13);
  expect(writeCount).toBe(6);
  expect(connectCount).toBe(1);
});

test("mesh controller times out a hung GATT write and closes the writer", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(saveMeshState(statePath, sampleState(7)));

  let writeCount = 0;
  let disconnectCount = 0;

  class HangingCharacteristic extends EventEmitter {
    readonly properties = ["writeWithoutResponse"];

    constructor(readonly uuid: string) {
      super();
    }

    writeAsync(): Promise<void> {
      writeCount++;
      return new Promise(() => undefined);
    }
  }

  class HangingService {
    readonly uuid = MESH_PROXY_SERVICE_UUID;

    async discoverCharacteristicsAsync(): Promise<HangingCharacteristic[]> {
      return [new HangingCharacteristic("2add")];
    }
  }

  class HangingNoble extends EventEmitter implements NobleLike {
    state = "poweredOn";

    async startScanningAsync(): Promise<void> {
      const peripheral: PeripheralLike & {
        connectAsync: () => Promise<void>;
        disconnectAsync: () => Promise<void>;
        discoverServicesAsync: () => Promise<HangingService[]>;
      } = {
        id: "aabbccddeeff",
        uuid: "aabbccddeeff",
        address: "AA:BB:CC:DD:EE:FF",
        advertisement: { localName: "GD_LED", serviceUuids: [MESH_PROXY_SERVICE_UUID] },
        connectAsync: async () => {},
        disconnectAsync: async () => {
          disconnectCount++;
        },
        discoverServicesAsync: async () => [new HangingService()],
      };
      queueMicrotask(() => this.emit("discover", peripheral));
    }

    async stopScanningAsync(): Promise<void> {}
  }

  __setNobleForTesting(new HangingNoble());
  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    writeTimeoutMs: 25,
  });

  const exit = await Effect.runPromiseExit(
    controller.send(Cct.make({ brightness: pct(10), temperature: kelvin(3200) })),
  );

  const state = await Effect.runPromise(loadMeshState(statePath));
  expect(exit._tag).toBe("Failure");
  expect(writeCount).toBe(1);
  expect(disconnectCount).toBe(1);
  expect(state.sequenceNumber).toBe(9);
});

test("mesh controller allows the peripheral scan timeout to be shortened", async () => {
  const statePath = join(dir, "state.json");
  await Effect.runPromise(saveMeshState(statePath, sampleState(7)));

  let scanCount = 0;

  class EmptyScanNoble extends EventEmitter implements NobleLike {
    state = "poweredOn";

    async startScanningAsync(): Promise<void> {
      scanCount++;
    }

    async stopScanningAsync(): Promise<void> {}
  }

  __setNobleForTesting(new EmptyScanNoble());
  const controller = makeMeshController({
    address: "AA:BB:CC:DD:EE:FF",
    statePath,
    findPeripheralTimeoutMs: 25,
  });

  const exit = await Effect.runPromiseExit(
    controller.send(Cct.make({ brightness: pct(10), temperature: kelvin(3200) })),
  );

  expect(exit._tag).toBe("Failure");
  expect(scanCount).toBe(1);
});
