// Transport-agnostic conveniences. Consumers (CLI, Homebridge plugin) bring
// their own Layer factory from @godox-tl/mesh and hand it to createLight —
// core stays free of BLE deps.

import { Effect, type Layer } from "effect";
import {
  LightController,
  type TransportError,
  type TransportUnsupportedError,
} from "./light/controller.ts";
import type { LightEntry } from "./registry.ts";

export interface DiscoveredDevice {
  readonly name: string;
  readonly address: string;
  readonly rssi: number;
  /** True when the device is advertising the Mesh Provisioning Service (0x1827). */
  readonly unprovisioned: boolean;
  /** Raw advertisement data, transport-specific. */
  readonly raw?: unknown;
}

export type LightLayerFactory = (
  entry: LightEntry,
) => Layer.Layer<LightController, TransportError | TransportUnsupportedError>;

/**
 * Resolve a controller for a registered light. The caller supplies a
 * transport-specific `layerFactory` (e.g. from `@godox-tl/mesh`).
 *
 * Example:
 * ```ts
 * import { createLight, getLight } from "@godox-tl/core";
 * import { makeNodeMeshLayer } from "@godox-tl/mesh";
 *
 * const program = Effect.gen(function* () {
 *   const entry = yield* getLight("kitchen");
 *   const light = yield* createLight(entry, (e) =>
 *     makeNodeMeshLayer({ address: e.address, statePath: e.statePath }),
 *   );
 *   yield* light.send(Off.make({}));
 * });
 * ```
 */
export const createLight = (
  entry: LightEntry,
  layerFactory: LightLayerFactory,
): Effect.Effect<LightController["Type"], TransportError | TransportUnsupportedError> =>
  LightController.pipe(Effect.provide(layerFactory(entry)));
