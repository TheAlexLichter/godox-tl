# @godox-tl/cli

The `godox` command-line interface for Godox TL30 BLE control, built on
[`@effect/cli`](https://effect.website/docs/cli/introduction). Provides scan,
lights, provision, rebind, CCT, HSI, RGBW, FX, off, rename, and forget
subcommands with auto-generated `--help` and type-safe option parsing.

Part of the [godox-tl monorepo](https://github.com/TheAlexLichter/godox-tl).

## Install

Install globally:

```bash
vp add -g @godox-tl/cli
# or: pnpm add -g @godox-tl/cli
godox --help
```

From this workspace:

```bash
vp install
vp run @godox-tl/cli#godox -- --help
```

The global install provides the `godox` binary. All examples below assume the
global CLI; from this workspace, prefix commands with
`vp run @godox-tl/cli#godox --`.

## Subcommands

```bash
godox scan [--timeout 10]
godox lights
godox provision <ble-address> --name <name>
godox rebind <light>
godox set <light> --brightness 0..100 --cct 2800..6500
godox hsi <light> --brightness 0..100 --hue 0..360 --saturation 0..100
godox rgbw <light> --brightness 0..100 [--red 0..255] [--green 0..255] [--blue 0..255] [--white 0..255]
godox fx <light> --brightness 0..100 --effect 0..255 [--level 0..255] [--filter 0..255]
godox off <light>
godox rename <old> <new>
godox forget <light>
```

## State on disk

- Registry: `~/.config/godox-tl/registry.json`
- Per-light mesh state: `~/.config/godox-tl/states/<name>.json` (network key,
  app key, device key, sequence number).

## Example session

```bash
# Factory-reset a light first (Bluetooth menu → RESET on the device).
godox scan --timeout 5
godox provision 83E72030-EF94-6299-21DD-372408DE38C2 --name kitchen
godox set kitchen --brightness 50 --cct 4500
godox hsi kitchen --brightness 100 --hue 0 --saturation 100
godox rgbw kitchen --brightness 10 --red 255
godox fx kitchen --brightness 100 --effect 2 --level 1
godox off kitchen
```

## Library wiring

The CLI is a thin shell around `@godox-tl/mesh` — anything it can do,
your code can do too:

```ts
import { Domain } from "@godox-tl/core";
import { makeMeshController } from "@godox-tl/mesh";
import { Effect } from "effect";

const light = makeMeshController({ address: "...", statePath: "..." });
await Effect.runPromise(
  light.send(
    Domain.Cct.make({
      brightness: Domain.pct(40),
      temperature: Domain.kelvin(4000),
    }),
  ),
);
```

## License

MIT.
