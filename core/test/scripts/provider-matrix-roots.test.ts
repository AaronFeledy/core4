import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { runBunCommand } from "../../../scripts/provider-matrix-report.ts";

test("acceptance test children and their CLI children retain all four job roots", async () => {
  const keys = [
    "LANDO_USER_DATA_ROOT",
    "LANDO_USER_CACHE_ROOT",
    "LANDO_USER_CONF_ROOT",
    "LANDO_SYSTEM_PLUGIN_ROOT",
  ];
  const expected = keys.flatMap((key) => {
    const root = process.env[key];
    return root === undefined ? [] : [root];
  });
  expect(expected).toHaveLength(keys.length);
  const preload = resolve(import.meta.dirname, "../../../scripts/test-preload.ts");
  const dump = `console.log(${JSON.stringify(keys)}.map(key => process.env[key]).join("\\n"));`;

  const result = await runBunCommand([
    process.execPath,
    "-e",
    `await import(${JSON.stringify(preload)}); ${dump}
const child = Bun.spawnSync({ cmd: [process.execPath, "-e", ${JSON.stringify(dump)}], stdout: "pipe" });
process.stdout.write(child.stdout); process.exit(child.exitCode);`,
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([...expected, ...expected]);
});
