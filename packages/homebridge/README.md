# homebridge-godox-tl

Homebridge dynamic platform plugin for Godox TL30 lights controlled over BLE SIG
Mesh. It exposes each light as a HomeKit `Lightbulb` with on/off, brightness,
color temperature, and optional HomeKit color controls.

The plugin uses the native Node.js mesh transport from the
[`godox-tl`](https://github.com/TheAlexLichter/godox-tl) project.

## Requirements

- Homebridge `^1.8.0` or `^2.0.0`.
- Node.js `^22.0.0` or `^24.0.0`.
- A Bluetooth adapter visible to the Homebridge host.
- Godox TL30 lights using the Godox Light app BLE mesh protocol.

On Linux, Node needs access to raw BLE sockets:

```bash
sudo setcap cap_net_raw+eip "$(readlink -f "$(which node)")"
```

## Install

In Homebridge UI, open **Plugins**, search for `homebridge-godox-tl`, and
install it.

For a command-line install in the same Node environment as Homebridge:

```bash
vp add -g homebridge-godox-tl
# or: pnpm add -g homebridge-godox-tl
```

## Quick Start

Add the platform in Homebridge UI, or add this to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "GodoxTL",
      "name": "Godox TL",
      "autoProvision": false,
      "startupScan": true,
      "autoProvisionOnStartup": true
    }
  ]
}
```

Factory-reset the light before first provisioning. With the default config,
Homebridge runs one startup scan and provisions matching factory-reset TL30
lights whose advertised name matches `^GD_LED$`.

You can also provision lights from the CLI and let Homebridge read that registry,
but both processes must use the same registry path and Homebridge must be able
to read and write the referenced state files:

```bash
vp add -g @godox-tl/cli
# or: pnpm add -g @godox-tl/cli

godox scan
godox provision <BLE-address> --name kitchen
```

The default registry is `~/.config/godox-tl/registry.json`; per-light mesh state
files live under `~/.config/godox-tl/states/`. If Homebridge runs as a different
service user, either run the CLI as that same user or set `registryPath` to the
CLI registry and make sure the Homebridge user can write the state files.

## Configuration

`config.schema.json` is included, so Homebridge UI can render the plugin
settings form. The platform alias is:

```json
{
  "platform": "GodoxTL"
}
```

| Field                    | Default                            | Description                                                                                                    |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `name`                   | `"Godox TL"`                       | Platform name shown in Homebridge logs.                                                                        |
| `registryPath`           | `~/.config/godox-tl/registry.json` | Registry JSON path. Leave empty for the default shared CLI registry.                                           |
| `discoveryMode`          | `"merge"`                          | `"registry"`, `"manual"`, or `"merge"` (registry plus manual overrides by name).                               |
| `autoProvision`          | `false`                            | Continuously scan and provision matching factory-reset lights after startup.                                   |
| `startupScan`            | `true`                             | Run one BLE scan when Homebridge starts.                                                                       |
| `startupPruneMissing`    | `false`                            | Remove registry entries missed by the startup scan. Leave off for normal BLE use; short scans can miss lights. |
| `autoProvisionOnStartup` | `true`                             | Provision matching factory-reset lights during the startup scan even when periodic auto-provision is off.      |
| `scanIntervalSeconds`    | `60`                               | Periodic scan interval. Clamped to at least 10 seconds.                                                        |
| `discoveryFilters`       | `["^GD_LED$"]`                     | JavaScript regex patterns matched against advertised BLE names.                                                |
| `nameTemplate`           | `"godox-{shortAddr}"`              | Name assigned to auto-provisioned lights. `{shortAddr}` expands to the last 6 hex chars of the BLE address.    |
| `enableColor`            | `true`                             | Adds HomeKit `Hue` and `Saturation` controls backed by Godox HSI mode.                                         |
| `fxPresets`              | `[]`                               | Optional momentary switch services: `{name, brightness?, effect, level?, filter?}`.                            |
| `rgbwPresets`            | `[]`                               | Optional momentary switch services: `{name, brightness?, red?, green?, blue?, white?}`.                        |
| `lights`                 | `[]`                               | Manual entries `{name, address, statePath, nodeAddress?}`.                                                     |

## HomeKit Services

Each light is exposed as a `Lightbulb` service with:

- `On`
- `Brightness`
- `ColorTemperature`
- `Hue` and `Saturation` when `enableColor` is enabled

State is cached inside the Homebridge process. Set handlers debounce rapid
HomeKit slider updates so the BLE mesh is not flooded.

Optional FX and RGBW presets appear as momentary `Switch` services named
`FX: <name>` and `RGBW: <name>`. Turning a preset switch on sends the command
and then resets the switch to off.

## Troubleshooting

- Confirm Homebridge is running on Node 22 or 24.
- Confirm the Linux BLE capability is set on the same `node` binary used by
  Homebridge.
- Run `godox scan` on the same host to verify the adapter can see the light.
- Factory-reset the TL30 if it does not appear as an unprovisioned device.
- Keep `startupPruneMissing` off unless you intentionally want missing scan
  results to remove accessories.
- Check Homebridge logs for `BLE scan complete`, `Auto-provision candidates`,
  and `Loaded ... known light(s)`.

## Development

From the monorepo:

```bash
vp install
vp run -r build
vp test -F homebridge-godox-tl
```

The plugin entry point is `src/index.ts`; the dynamic platform implementation is
in `src/platform.ts`; accessory behavior is in `src/accessory.ts`.

## Credit

The underlying mesh protocol implementation builds on reverse-engineering from
[`mattharrison/godox-ul60bi-bt`](https://github.com/mattharrison/godox-ul60bi-bt)
(MIT). See [`@godox-tl/mesh`](https://github.com/TheAlexLichter/godox-tl/tree/main/packages/mesh)
for details.

## License

MIT.
