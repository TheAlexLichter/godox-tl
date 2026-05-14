#!/usr/bin/env node
// Raw end-to-end mesh test for the Pi. Skips Homebridge's plugin lifecycle
// so we can iterate on the BLE/mesh flow in isolation.
//
// Drop into /var/lib/homebridge/node_modules/homebridge-godox-tl/ on the Pi
// so the plain imports resolve through the deployed plugin's node_modules.
//
// Usage on the Pi:
//   cd /var/lib/homebridge/node_modules/homebridge-godox-tl
//   sudo -u homebridge /opt/homebridge/bin/node pi-test.mjs scan
//   sudo -u homebridge /opt/homebridge/bin/node pi-test.mjs provision <addr> [statePath]
//   sudo -u homebridge /opt/homebridge/bin/node pi-test.mjs set <addr> <statePath> [bright] [cct]
//   sudo -u homebridge /opt/homebridge/bin/node pi-test.mjs off <addr> <statePath>
//   sudo -u homebridge /opt/homebridge/bin/node pi-test.mjs load-state <statePath>

import { Effect, LogLevel, Logger } from "effect";
import { Domain } from "@godox-tl/core";
import { loadMeshState, makeMeshController, provisionAndRebind, scanDevices } from "@godox-tl/mesh";

const cmd = process.argv[2];

const verbose = Logger.minimumLogLevel(LogLevel.Debug);

const main = (() => {
  switch (cmd) {
    case "scan": {
      return Effect.gen(function* () {
        yield* Effect.logInfo("Scanning 10s…");
        const devices = yield* scanDevices({ timeoutSeconds: 10 });
        yield* Effect.logInfo(`Found ${devices.length} Godox-like device(s):`);
        for (const d of devices) {
          yield* Effect.logInfo(
            `  ${d.address}  name='${d.name}'  rssi=${d.rssi}  unprov=${d.unprovisioned}`,
          );
        }
      });
    }
    case "provision": {
      const addr = process.argv[3];
      const statePath = process.argv[4] ?? "/tmp/pi-mesh-test-state.json";
      if (!addr) {
        console.error("usage: provision <addr> [statePath]");
        process.exit(2);
      }
      return Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.logInfo(`Provisioning ${addr} → ${statePath}`);
          const r = yield* provisionAndRebind(addr, { statePath });
          yield* Effect.logInfo(
            `✓ node=0x${r.state.nodeAddress.toString(16)} seq=${r.state.sequenceNumber}`,
          );
        }),
      );
    }
    case "find-and-provision": {
      // Single fused operation: scan, identify the first unprovisioned
      // Godox light, provision it. Avoids state drift between two separate
      // CLI invocations.
      const statePath = process.argv[3] ?? "/tmp/pi-mesh-test-state.json";
      return Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.logInfo("Scanning 10s for an unprovisioned light…");
          const devices = yield* scanDevices({ timeoutSeconds: 10 });
          const target = devices.find((d) => d.unprovisioned);
          if (!target) {
            yield* Effect.logWarning(
              `No unprovisioned Godox light found. Devices seen: ${devices
                .map((d) => `${d.address}(${d.name}, unprov=${d.unprovisioned})`)
                .join(" ")}`,
            );
            return;
          }
          yield* Effect.logInfo(
            `Provisioning ${target.address} (${target.name}, rssi=${target.rssi}) → ${statePath}`,
          );
          // brief settle between scan stop and provisioning's connect scan
          yield* Effect.sleep("1500 millis");
          const r = yield* provisionAndRebind(target.address, { statePath });
          yield* Effect.logInfo(
            `✓ node=0x${r.state.nodeAddress.toString(16)} seq=${r.state.sequenceNumber}`,
          );
        }),
      );
    }
    case "set": {
      const addr = process.argv[3];
      const statePath = process.argv[4];
      const brightness = Number(process.argv[5] ?? "30");
      const cct = Number(process.argv[6] ?? "4000");
      const light = makeMeshController({ address: addr, statePath });
      return Effect.gen(function* () {
        yield* Effect.logInfo(`Set ${addr}: brightness=${brightness} cct=${cct}`);
        yield* light.send(
          Domain.Cct.make({
            brightness: Domain.pct(brightness),
            temperature: Domain.kelvin(cct),
          }),
        );
        yield* Effect.logInfo("done");
      });
    }
    case "off": {
      const addr = process.argv[3];
      const statePath = process.argv[4];
      const light = makeMeshController({ address: addr, statePath });
      return Effect.gen(function* () {
        yield* Effect.logInfo(`Off ${addr}`);
        yield* light.send(Domain.Off.make({}));
        yield* Effect.logInfo("done");
      });
    }
    case "inspect": {
      // Raw GATT probe: connect to an address, list every primary service +
      // characteristic via noble directly. Bypasses our mesh wrappers so we
      // can see exactly what the device exposes (e.g. is "1827" really there?).
      const addr = process.argv[3];
      if (!addr) {
        console.error("usage: inspect <addr>");
        process.exit(2);
      }
      return Effect.tryPromise({
        try: async () => {
          console.log("inspect: importing noble…");
          // pnpm hides transitive deps from the top-level package: import via the explicit virtual-store path.
          const nobleMod =
            await import("/var/lib/homebridge/node_modules/homebridge-godox-tl/node_modules/.pnpm/@stoprocent+noble@2.5.3/node_modules/@stoprocent/noble/index.js");
          const noble = nobleMod.default ?? nobleMod;
          console.log(`inspect: noble loaded, state=${noble.state}`);
          while (noble.state !== "poweredOn") {
            await new Promise((r) => setTimeout(r, 100));
          }
          let found;
          const id = addr.toLowerCase().replace(/[^0-9a-f]/g, "");
          const onDiscover = (p) => {
            const pid = (p.uuid || p.address || "").toLowerCase().replace(/[^0-9a-f]/g, "");
            if (pid === id && !found) found = p;
          };
          noble.on("discover", onDiscover);
          await noble.startScanningAsync([], true);
          const t0 = Date.now();
          while (!found && Date.now() - t0 < 15000) {
            await new Promise((r) => setTimeout(r, 100));
          }
          await noble.stopScanningAsync();
          noble.removeListener("discover", onDiscover);
          if (!found) throw new Error("peripheral not seen");
          console.log(`ADV serviceUuids: ${(found.advertisement.serviceUuids || []).join(",")}`);
          console.log(`ADV localName: ${found.advertisement.localName}`);
          console.log(
            `ADV manufacturerData: ${(found.advertisement.manufacturerData || Buffer.alloc(0)).toString("hex")}`,
          );
          await found.connectAsync();
          console.log("connected; waiting 3s for GATT to populate…");
          await new Promise((r) => setTimeout(r, 3000));
          console.log("trying targeted discoverServicesAsync(['1827'])…");
          let services = [];
          try {
            services = await found.discoverServicesAsync(["1827"]);
            console.log(`  → ${services.length} service(s)`);
          } catch (e) {
            console.log(`  rejected: ${e?.message ?? e}`);
          }
          if (services.length === 0) {
            console.log("trying discoverServicesAsync() (all)…");
            services = await found.discoverServicesAsync();
            console.log(`  → ${services.length} service(s)`);
          }
          console.log(`GATT primary services (${services.length}):`);
          for (const s of services) {
            console.log(`  ${s.uuid}`);
            try {
              const chars = await s.discoverCharacteristicsAsync();
              for (const c of chars) {
                console.log(`    ${c.uuid} [${(c.properties || []).join("|")}]`);
              }
            } catch (e) {
              console.log(`    (char discovery failed: ${e?.message ?? e})`);
            }
          }
          await found.disconnectAsync();
          process.exit(0);
        },
        catch: (e) => new Error(`inspect failed: ${e?.message ?? String(e)}`),
      });
    }
    case "load-state": {
      const statePath = process.argv[3];
      return Effect.gen(function* () {
        const state = yield* loadMeshState(statePath);
        yield* Effect.logInfo(
          `Loaded: nodeAddr=${state.nodeAddress} seq=${state.sequenceNumber} ivIndex=${state.ivIndex} prov=${state.provisionerAddress}`,
        );
      });
    }
    default: {
      console.error("usage: pi-test.mjs {scan|provision|set|off|load-state} ...");
      process.exit(2);
    }
  }
})();

Effect.runPromise(main.pipe(Effect.provide(verbose))).catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
