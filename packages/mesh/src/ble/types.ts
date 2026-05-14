// Shared types for the BLE transport.
//
// The Mesh Proxy GATT profile (Bluetooth Mesh Profile §6) exposes two
// characteristics on service `1828`:
//   * `2add` "Mesh Proxy Data In"  — proxy client → proxy server (writes)
//   * `2ade` "Mesh Proxy Data Out" — proxy server → proxy client (notifications)
// Unprovisioned beacons advertise service `1827` ("Mesh Provisioning Service")
// instead and use characteristics `2adb` / `2adc`. Milestone 3 only handles
// the post-provisioning proxy path; the provisioning bearer arrives later.

import type { DiscoveredDevice } from "@godox-tl/core";
import type { Effect, Stream } from "effect";
import type { BleError } from "./errors.ts";

export type { DiscoveredDevice };

export interface BleScanOptions {
  /** Scan duration in seconds. Defaults to 5s, matching the Python helper. */
  readonly timeoutSeconds?: number;
  /** Optional predicate run against each candidate device after the basic
   *  Godox-shape check. Use it to narrow to a known address or local-name
   *  prefix; non-matching devices are simply dropped. */
  readonly filter?: (device: DiscoveredDevice) => boolean;
}

/**
 * An open Mesh Proxy GATT connection. Lifetime is bound to the Scope passed to
 * `connectProxy`; closing the Scope unsubscribes notifications and disconnects
 * the peripheral.
 */
export interface ProxyConnection {
  /** Stable device identifier the connection was opened against. */
  readonly address: string;
  /** Send a complete Mesh Proxy PDU to `2add`. The first byte carries the
   *  SAR header + message type; the rest is the (possibly segmented) mesh
   *  PDU. Writes use "without response" to mirror the upstream Python
   *  client (`client.py::ProxyClient.write_proxy`, `response=False`). */
  readonly write: (pdu: Uint8Array) => Effect.Effect<void, BleError>;
  /** Notifications streamed off `2ade`. Each emission is a single GATT
   *  notification payload — the proxy layer above this stitches segments
   *  back together. The stream completes when the underlying Scope is
   *  closed (peripheral disconnected). */
  readonly notifications: Stream.Stream<Uint8Array, BleError>;
}

/**
 * Write-only Mesh Proxy GATT connection for normal light-control commands.
 * It skips notification subscription and can be cached by long-running
 * consumers, then closed after an idle timeout.
 */
export interface ProxyWriterConnection {
  /** Stable device identifier the connection was opened against. */
  readonly address: string;
  /** Send a complete Mesh Proxy PDU to `2add`. */
  readonly write: (pdu: Uint8Array) => Effect.Effect<void, BleError>;
  /** Disconnect the underlying GATT peripheral. Safe to call more than once. */
  readonly close: () => Effect.Effect<void>;
}
