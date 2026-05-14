// One-shot helpers that compose milestones 4+5+state into the operations
// the CLI and Homebridge plugin actually call (`provisionAndRebind`, etc.).

import { Effect } from "effect";
import { provisionLight, type ProvisioningResult } from "./provisioning/index.ts";
import { rebindNode } from "./config/index.ts";
import { saveMeshState, type MeshState } from "./state.ts";

export interface ProvisionAndRebindOptions {
  /** Persist the final mesh state to this path when both steps succeed. Optional. */
  readonly statePath?: string;
  readonly networkKey?: Uint8Array;
  readonly appKey?: Uint8Array;
  readonly nodeAddress?: number;
}

export interface ProvisionAndRebindResult {
  readonly state: MeshState;
  readonly provisioning: ProvisioningResult;
}

/**
 * Full provisioning flow: PB-GATT provisioning → ConfigSession (App Key Add +
 * Model App Bind) → optional state-file write. Equivalent to running
 * `godox-ul60bi provision` followed by `godox-ul60bi rebind`, but native Node.
 */
export const provisionAndRebind = (address: string, options: ProvisionAndRebindOptions = {}) =>
  Effect.gen(function* () {
    // Each step opens its OWN GATT connection. Wrap in Effect.scoped so the
    // provisioning connection is fully released (peripheral disconnected,
    // notifications torn down) before rebind tries to open a fresh proxy
    // connection — otherwise noble rejects the second connect with
    // "Peripheral already connected".
    const provisioning = yield* Effect.scoped(
      provisionLight(address, {
        networkKey: options.networkKey,
        appKey: options.appKey,
        nodeAddress: options.nodeAddress,
      }),
    );

    // Persist the keys *before* rebind. If rebind fails (e.g. the light is
    // slow to switch from the Provisioning service to the Proxy service),
    // the user can re-run `rebind` separately without having lost the
    // keys — otherwise the light would be bricked-to-us.
    const preRebind: MeshState = {
      networkKey: provisioning.networkKey,
      appKey: provisioning.appKey,
      deviceKey: provisioning.deviceKey,
      ivIndex: provisioning.ivIndex,
      provisionerAddress: provisioning.provisionerAddress,
      nodeAddress: provisioning.nodeAddress,
      sequenceNumber: provisioning.sequenceNumber,
      deviceAddress: address,
    };
    if (options.statePath) {
      yield* saveMeshState(options.statePath, preRebind);
    }

    // Give the light a beat to drop the Provisioning advertisement and start
    // advertising the Mesh Proxy service. 1.5 s is conservative — Telink
    // devices typically switch within ~500 ms.
    yield* Effect.sleep("1500 millis");

    const rebind = yield* Effect.scoped(
      rebindNode(address, {
        networkKey: provisioning.networkKey,
        appKey: provisioning.appKey,
        deviceKey: provisioning.deviceKey,
        ivIndex: provisioning.ivIndex,
        provisionerAddress: provisioning.provisionerAddress,
        nodeAddress: provisioning.nodeAddress,
        sequenceNumber: provisioning.sequenceNumber,
      }),
    );

    const state: MeshState = { ...preRebind, sequenceNumber: rebind.sequenceNumber };

    if (options.statePath) {
      yield* saveMeshState(options.statePath, state);
    }

    return { state, provisioning } satisfies ProvisionAndRebindResult;
  });
