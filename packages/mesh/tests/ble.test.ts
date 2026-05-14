// Unit tests for the BLE transport. Hardware-dependent tests are guarded by
// the MESH_BLE_AVAILABLE env var so CI never tries to drive a real adapter.

import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import {
  __setNobleForTesting,
  buildDiscoveredDevice,
  connectProxyWriter,
  dedupeDevices,
  MESH_PROVISIONING_SERVICE_UUID,
  MESH_PROXY_SERVICE_UUID,
  scanDevices,
} from "../src/ble/index.ts";
import type { NobleLike, PeripheralLike } from "../src/ble/noble.ts";

const hardwareAvailable = process.env.MESH_BLE_AVAILABLE === "1";

afterEach(() => {
  __setNobleForTesting(undefined);
});

// --- buildDiscoveredDevice -------------------------------------------------

test("buildDiscoveredDevice: uses localName when present and reports proxy device as provisioned", () => {
  const peripheral: PeripheralLike = {
    id: "abc",
    uuid: "abc",
    address: "AA:BB:CC:DD:EE:FF",
    rssi: -55,
    advertisement: {
      localName: "GD_LED",
      serviceUuids: [MESH_PROXY_SERVICE_UUID],
    },
  };
  const device = buildDiscoveredDevice(peripheral);
  expect(device.name).toBe("GD_LED");
  expect(device.address).toBe("AA:BB:CC:DD:EE:FF");
  expect(device.rssi).toBe(-55);
  expect(device.unprovisioned).toBe(false);
});

test("buildDiscoveredDevice: falls back to GD_LED when mesh service is advertised without a localName", () => {
  const peripheral: PeripheralLike = {
    id: "macos-uuid",
    uuid: "macos-uuid",
    address: "",
    rssi: -70,
    advertisement: {
      serviceUuids: [MESH_PROVISIONING_SERVICE_UUID],
    },
  };
  const device = buildDiscoveredDevice(peripheral);
  expect(device.name).toBe("GD_LED");
  expect(device.address).toBe("macos-uuid"); // falls back to uuid on macOS
  expect(device.unprovisioned).toBe(true);
});

test("buildDiscoveredDevice: handles service UUIDs in any case", () => {
  const peripheral: PeripheralLike = {
    id: "x",
    uuid: "x",
    address: "11:22:33:44:55:66",
    rssi: -42,
    advertisement: {
      localName: "Light",
      serviceUuids: ["1827", "180A"],
    },
  };
  const device = buildDiscoveredDevice(peripheral);
  expect(device.unprovisioned).toBe(true);
});

test("buildDiscoveredDevice: empty name when neither localName nor mesh service is present", () => {
  const peripheral: PeripheralLike = {
    id: "y",
    uuid: "y",
    address: "11:22:33:44:55:66",
    rssi: -42,
    advertisement: { serviceUuids: ["180a"] },
  };
  const device = buildDiscoveredDevice(peripheral);
  expect(device.name).toBe("");
  expect(device.unprovisioned).toBe(false);
});

// --- dedupeDevices ---------------------------------------------------------

test("dedupeDevices: keeps latest entry per address", () => {
  const out = dedupeDevices([
    { name: "GD_LED", address: "AA:BB", rssi: -80, unprovisioned: false },
    { name: "GD_LED", address: "CC:DD", rssi: -70, unprovisioned: false },
    { name: "GD_LED", address: "AA:BB", rssi: -55, unprovisioned: false }, // newer
  ]);
  expect(out).toHaveLength(2);
  const aa = out.find((d) => d.address === "AA:BB");
  expect(aa?.rssi).toBe(-55);
});

test("dedupeDevices: drops entries without an address", () => {
  const out = dedupeDevices([
    { name: "GD_LED", address: "", rssi: -55, unprovisioned: false },
    { name: "GD_LED", address: "AA:BB", rssi: -55, unprovisioned: false },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]?.address).toBe("AA:BB");
});

// --- scanDevices with a fake noble ----------------------------------------

class FakeNoble extends EventEmitter implements NobleLike {
  state = "poweredOn";
  startCalled = false;
  stopCalled = false;
  startArgs: { uuids?: ReadonlyArray<string>; duplicates?: boolean } | undefined;

  startScanningAsync(
    serviceUuids?: ReadonlyArray<string>,
    allowDuplicates?: boolean,
  ): Promise<void> {
    this.startCalled = true;
    this.startArgs = { uuids: serviceUuids, duplicates: allowDuplicates };
    // Emit a few discoveries asynchronously, including a duplicate address.
    queueMicrotask(() => {
      this.emit("discover", {
        id: "abc",
        uuid: "abc",
        address: "AA:BB:CC:DD:EE:01",
        rssi: -80,
        advertisement: {
          localName: "GD_LED",
          serviceUuids: [MESH_PROXY_SERVICE_UUID],
        },
      });
      this.emit("discover", {
        id: "def",
        uuid: "def",
        address: "AA:BB:CC:DD:EE:02",
        rssi: -60,
        advertisement: {
          localName: "GD_LED 2",
          serviceUuids: [MESH_PROVISIONING_SERVICE_UUID],
        },
      });
      // Duplicate of first device, newer rssi
      this.emit("discover", {
        id: "abc",
        uuid: "abc",
        address: "AA:BB:CC:DD:EE:01",
        rssi: -55,
        advertisement: {
          localName: "GD_LED",
          serviceUuids: [MESH_PROXY_SERVICE_UUID],
        },
      });
      // Entry without any usable address — should be dropped.
      this.emit("discover", {
        id: "",
        uuid: "",
        address: "",
        rssi: -90,
        advertisement: { serviceUuids: [MESH_PROXY_SERVICE_UUID] },
      });
    });
    return Promise.resolve();
  }

  stopScanningAsync(): Promise<void> {
    this.stopCalled = true;
    return Promise.resolve();
  }
}

test("scanDevices: collects, de-dupes by address, applies filter, stops scan on timeout", async () => {
  const fake = new FakeNoble();
  const devices = await Effect.runPromise(scanDevices({ timeoutSeconds: 0.05 }, fake));
  expect(fake.startCalled).toBe(true);
  expect(fake.startArgs?.uuids).toEqual([MESH_PROXY_SERVICE_UUID, MESH_PROVISIONING_SERVICE_UUID]);
  expect(fake.startArgs?.duplicates).toBe(true);
  expect(fake.stopCalled).toBe(true);

  expect(devices).toHaveLength(2);
  const first = devices.find((d) => d.address === "AA:BB:CC:DD:EE:01");
  expect(first?.rssi).toBe(-55); // newer reading won
  expect(first?.unprovisioned).toBe(false);
  const second = devices.find((d) => d.address === "AA:BB:CC:DD:EE:02");
  expect(second?.unprovisioned).toBe(true);
});

test("scanDevices: filter narrows the result set", async () => {
  const fake = new FakeNoble();
  const devices = await Effect.runPromise(
    scanDevices(
      {
        timeoutSeconds: 0.05,
        filter: (d) => d.address === "AA:BB:CC:DD:EE:02",
      },
      fake,
    ),
  );
  expect(devices).toHaveLength(1);
  expect(devices[0]?.address).toBe("AA:BB:CC:DD:EE:02");
});

test("scanDevices: surfaces a BleError when the adapter never powers on", async () => {
  class StuckNoble extends EventEmitter implements NobleLike {
    state = "poweredOff";
    startScanningAsync(): Promise<void> {
      throw new Error("should not start");
    }
    stopScanningAsync(): Promise<void> {
      return Promise.resolve();
    }
  }
  const stuck = new StuckNoble();
  // Note: scan.ts uses a 5s wait-for-poweredOn timeout. Drive it by emitting
  // an `unauthorized` state change, which short-circuits immediately.
  setTimeout(() => stuck.emit("stateChange", "unauthorized"), 1);
  const exit = await Effect.runPromiseExit(scanDevices({}, stuck));
  expect(exit._tag).toBe("Failure");
});

test("connectProxyWriter: disconnects when discovery fails after connect", async () => {
  let disconnectCount = 0;

  class MissingDataInService {
    readonly uuid = MESH_PROXY_SERVICE_UUID;

    async discoverCharacteristicsAsync(): Promise<Array<{ readonly uuid: string }>> {
      return [{ uuid: "2ade" }];
    }
  }

  class DiscoveryFailureNoble extends EventEmitter implements NobleLike {
    state = "poweredOn";

    async startScanningAsync(): Promise<void> {
      const peripheral: PeripheralLike & {
        connectAsync: () => Promise<void>;
        disconnectAsync: () => Promise<void>;
        discoverServicesAsync: () => Promise<MissingDataInService[]>;
      } = {
        id: "aabbccddeeff",
        uuid: "aabbccddeeff",
        address: "AA:BB:CC:DD:EE:FF",
        advertisement: { localName: "GD_LED", serviceUuids: [MESH_PROXY_SERVICE_UUID] },
        connectAsync: async () => {},
        disconnectAsync: async () => {
          disconnectCount++;
        },
        discoverServicesAsync: async () => [new MissingDataInService()],
      };
      queueMicrotask(() => this.emit("discover", peripheral));
    }

    async stopScanningAsync(): Promise<void> {}
  }

  __setNobleForTesting(new DiscoveryFailureNoble());

  const exit = await Effect.runPromiseExit(connectProxyWriter("AA:BB:CC:DD:EE:FF"));

  expect(exit._tag).toBe("Failure");
  expect(disconnectCount).toBe(1);
});

// --- Hardware path (skipped by default) -----------------------------------

test.skipIf(!hardwareAvailable)(
  "scanDevices: hardware smoke test (requires MESH_BLE_AVAILABLE=1)",
  async () => {
    const devices = await Effect.runPromise(scanDevices({ timeoutSeconds: 5 }));
    // Don't assert on content — just confirm the type and that the scan ran.
    expect(Array.isArray(devices)).toBe(true);
  },
);
