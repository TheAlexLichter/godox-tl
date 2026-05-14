# @godox-tl/core

Domain types, the `LightController` service, registry, and transport-agnostic
factory helpers for [Godox TL30](https://www.godox.com/) BLE control. The
shared library every other `@godox-tl/*` package builds on.

Part of the [godox-tl monorepo](https://github.com/TheAlexLichter/godox-tl).

## Install

```bash
vp install                   # workspace
# or, externally:
vp add @godox-tl/core
# pnpm equivalent:
pnpm add @godox-tl/core
```

## What's in here

- **Domain** (`Domain.*`) — branded types (`Percent`, `Hue`, `Saturation`,
  `Kelvin`, `Byte`) + a tagged `LightCommand` union (`Off`, `Cct`, `Hsi`,
  `Rgbw`, `Fx`) + smart constructors (`pct`, `kelvin`, …).
- **`LightController`** — an Effect `Context.Tag` whose service is
  `{ send(cmd): Effect.Effect<void, TransportError | TransportUnsupportedError> }`.
  Transport packages such as `@godox-tl/mesh` provide the implementation.
- **Registry** — a per-host JSON registry at `~/.config/godox-tl/registry.json`
  mapping `name → { address, statePath, nodeAddress, provisionedAt }`. Atomic
  writes, XDG-aware location.
- **Experimental DMX transport** — `makeDmxLayer({ driver, mode, startChannel })`
  over [`dmx-ts`](https://www.npmjs.com/package/dmx-ts) (Art-Net, sACN, Enttec,
  DMXKing). This is manual-derived/internal and not part of the tested TL30
  BLE path.
- **`createLight(entry, layerFactory)`** — convenience that resolves a
  `LightController` from a registered light entry using whichever transport
  the caller passes in.

## Example

```ts
import { Effect, Layer } from "effect";
import { createLight, Domain, getLight, LightController } from "@godox-tl/core";
import { makeMeshController } from "@godox-tl/mesh";

const program = Effect.gen(function* () {
  const entry = yield* getLight("kitchen");
  const light = yield* createLight(entry, (e) =>
    Layer.succeed(
      LightController,
      makeMeshController({ address: e.address, statePath: e.statePath }),
    ),
  );
  yield* light.send(
    Domain.Cct.make({
      brightness: Domain.pct(75),
      temperature: Domain.kelvin(4200),
    }),
  );
});

await Effect.runPromise(program);
```

## Design

Core has **no BLE dependencies**. Transports are leaf packages, keeping native
dependency cost (`@stoprocent/noble` for mesh) out of the shared domain layer.

## License

MIT.
