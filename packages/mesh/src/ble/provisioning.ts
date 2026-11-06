// The provisioning bearer shares native connection ownership, scan shutdown,
// and scoped notification cleanup with the Mesh Proxy bearer.

import type { Effect, Scope } from "effect";
import { connectMeshProfile } from "./proxy.ts";
import type { BleError } from "./errors.ts";
import { MESH_PROVISIONING_SERVICE_UUID } from "./scan.ts";
import type { ProxyConnection } from "./types.ts";

/** Open the PB-GATT profile of an unprovisioned node. Keep the scan-only path
 * and Telink settle window while sharing bounded, cancellation-safe cleanup.
 */
export const connectProvisioning = (
  address: string,
): Effect.Effect<ProxyConnection, BleError, Scope.Scope> =>
  connectMeshProfile(
    address,
    {
      name: "Mesh Provisioning",
      serviceUuid: MESH_PROVISIONING_SERVICE_UUID,
      dataInUuid: "2adb",
      dataOutUuid: "2adc",
      scanOnly: true,
    },
    { findPeripheralTimeoutMs: 25_000 },
  );
