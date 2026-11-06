import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

const cli = fileURLToPath(new URL("../dist/godox.mjs", import.meta.url));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "godox-cli-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: directory, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 5_000,
  });

test("CLI help retains commands, named flags, and the light argument", () => {
  const result = run("set", "--help");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--brightness");
  expect(result.stdout).toContain("--cct");
  expect(result.stdout).toContain("light");
});

test("CLI parses control arguments and exits on an unknown registered light", () => {
  const result = run("set", "missing", "--brightness", "30", "--cct", "4000");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain("missing");
  expect(result.stdout + result.stderr).toMatch(/ERROR.*missing:/);
});

test("CLI rejects invalid integers before running a command", () => {
  const result = run("set", "missing", "--brightness", "oops", "--cct", "4000");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain("oops");
});
