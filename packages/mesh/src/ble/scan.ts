// Discover Godox lights advertising the Bluetooth Mesh Proxy (0x1828) or
// Mesh Provisioning (0x1827) service. Port of upstream `scanner.scan`.
//
// We deliberately bridge noble's event-emitter API to Effect via
// `Effect.async` so the caller gets a single Effect with a clean
// interrupt path (stopScanningAsync runs on every exit).

import type { DiscoveredDevice } from "@godox-tl/core";
import { Effect } from "effect";
import { BleError } from "./errors.ts";
import { getNoble, type NobleLike, type PeripheralLike, withNobleOperation } from "./noble.ts";
import type { BleScanOptions } from "./types.ts";

// Service UUIDs are normalised to lower-case 16-bit hex without dashes — that
// matches noble's reported `serviceUuids` shape on macOS and Linux.
export const MESH_PROXY_SERVICE_UUID = "1828";
export const MESH_PROVISIONING_SERVICE_UUID = "1827";

const DEFAULT_TIMEOUT_SECONDS = 5;
const POWERED_ON_TIMEOUT_MS = 5_000;

/**
 * Build a DiscoveredDevice from a noble Peripheral. Exported for tests.
 *
 * - `name`: prefers `advertisement.localName`, then falls back to "GD_LED" if
 *   the device is advertising one of the mesh service UUIDs (Godox lights
 *   advertise these in unprovisioned and provisioned modes alike).
 * - `address`: `peripheral.address` on Linux (a real MAC), `peripheral.uuid`
 *   on macOS (a CoreBluetooth-assigned UUID). Noble keeps `address` empty on
 *   macOS, so we always prefer it when non-empty, otherwise fall back to
 *   `uuid` / `id`.
 * - `unprovisioned`: true iff the device is advertising service 0x1827.
 */
export const buildDiscoveredDevice = (peripheral: PeripheralLike): DiscoveredDevice => {
  const adv = peripheral.advertisement ?? {};
  const serviceUuids = (adv.serviceUuids ?? []).map((u) => u.toLowerCase());
  const advertisesMesh =
    serviceUuids.includes(MESH_PROXY_SERVICE_UUID) ||
    serviceUuids.includes(MESH_PROVISIONING_SERVICE_UUID);

  const localName = adv.localName;
  const name = localName && localName.length > 0 ? localName : advertisesMesh ? "GD_LED" : "";

  const macAddress = peripheral.address;
  const address =
    macAddress && macAddress.length > 0 ? macAddress : (peripheral.uuid ?? peripheral.id ?? "");

  return {
    name,
    address,
    rssi: peripheral.rssi ?? 0,
    unprovisioned: serviceUuids.includes(MESH_PROVISIONING_SERVICE_UUID),
    raw: {
      id: peripheral.id,
      uuid: peripheral.uuid,
      serviceUuids,
      localName,
    },
  };
};

/**
 * Pure de-duplication: keep the most recent entry per `address`. Empty
 * addresses are dropped (a device we cannot route back to is useless).
 * Exported for tests.
 */
export const dedupeDevices = (
  devices: ReadonlyArray<DiscoveredDevice>,
): ReadonlyArray<DiscoveredDevice> => {
  const byAddress = new Map<string, DiscoveredDevice>();
  for (const d of devices) {
    if (!d.address) continue;
    byAddress.set(d.address, d);
  }
  return Array.from(byAddress.values());
};

const waitForPoweredOn = (noble: NobleLike): Effect.Effect<void, BleError> =>
  Effect.async<void, BleError>((resume) => {
    if (noble.state === "poweredOn") {
      resume(Effect.void);
      return;
    }

    let settled = false;
    const onChange = (state: string): void => {
      if (settled) return;
      if (state === "poweredOn") {
        settled = true;
        cleanup();
        resume(Effect.void);
      } else if (state === "unauthorized" || state === "unsupported") {
        settled = true;
        cleanup();
        resume(
          Effect.fail(
            new BleError({
              message: `BLE adapter reported state '${state}'. On macOS, grant Bluetooth permission to your terminal in System Settings → Privacy & Security → Bluetooth.`,
            }),
          ),
        );
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(
        Effect.fail(
          new BleError({
            message: `BLE adapter never reached 'poweredOn' (last state: '${noble.state}'). Is Bluetooth turned on?`,
          }),
        ),
      );
    }, POWERED_ON_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timer);
      noble.removeListener("stateChange", onChange);
    };

    noble.on("stateChange", onChange);
  });

/**
 * Scan for nearby Mesh-capable BLE devices. The scan runs for
 * `timeoutSeconds` (default 5s), then resolves with a de-duplicated list.
 *
 * The optional `noble` parameter is for tests; in production code call this
 * without arguments and the module-private singleton is used.
 */
export const scanDevices = (
  opts: BleScanOptions = {},
  nobleOverride?: NobleLike,
): Effect.Effect<ReadonlyArray<DiscoveredDevice>, BleError> =>
  withNobleOperation(
    Effect.gen(function* () {
      const noble = nobleOverride ?? (yield* getNoble);
      const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

      yield* waitForPoweredOn(noble);

      const collected: DiscoveredDevice[] = [];
      const filter = opts.filter;

      const result = yield* Effect.async<ReadonlyArray<DiscoveredDevice>, BleError>((resume) => {
        let settled = false;

        const onDiscover = (peripheral: PeripheralLike): void => {
          try {
            const device = buildDiscoveredDevice(peripheral);
            if (!device.address) return;
            if (filter && !filter(device)) return;
            collected.push(device);
          } catch {
            // Discovery callbacks must never throw; just skip a malformed entry.
          }
        };

        noble.on("discover", onDiscover);

        const finish = (next: Effect.Effect<ReadonlyArray<DiscoveredDevice>, BleError>): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          noble.removeListener("discover", onDiscover);
          // Best-effort stop; we surface scan errors but ignore stop errors.
          noble.stopScanningAsync().catch(() => undefined);
          resume(next);
        };

        const timer = setTimeout(() => {
          finish(Effect.succeed(dedupeDevices(collected)));
        }, timeoutSeconds * 1_000);

        // `allowDuplicates: true` so we receive fresh RSSI per advertisement
        // instead of a single cached report per device.
        noble
          .startScanningAsync([MESH_PROXY_SERVICE_UUID, MESH_PROVISIONING_SERVICE_UUID], true)
          .catch((cause: unknown) => {
            finish(
              Effect.fail(
                new BleError({
                  cause,
                  message: `Failed to start BLE scan: ${(cause as Error | undefined)?.message ?? String(cause)}`,
                }),
              ),
            );
          });

        return Effect.sync(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          noble.removeListener("discover", onDiscover);
          noble.stopScanningAsync().catch(() => undefined);
        });
      });

      return result;
    }),
  );
