import { resolve } from "node:path";

import {
  COMMAND_INDEX_SCHEMA_VERSION,
  encodeAppCommandIndex,
  encodePluginCommandIndex,
} from "@lando/engine/cache/command-index";

// Explicit golden refresh: bun run codegen:command-cache-fixtures.
// Keep outside automatic codegen so encoder drift fails the byte-equality tests.
// Retain older versions as stale-cache rejection fixtures.
const root = resolve(import.meta.dirname, "../core/test/cache/fixtures/binary-cache");
const version = Number(COMMAND_INDEX_SCHEMA_VERSION);

await Bun.write(
  resolve(root, `app-command-v${version}.bin`),
  encodeAppCommandIndex({
    schemaVersion: version,
    landoVersion: "0.0.0",
    appName: "fixture-app",
    sourceFile: "/workspace/fixture-app/.lando.yml",
    sourceMtimeMs: 1_700_000_000_000,
    sourceSize: 128,
    versionConstraints: [],
    generatedAtMs: 1_700_000_100_000,
    entries: [{ id: "fixture:task", summary: "Fixture task", hidden: false, service: "appserver" }],
  }),
);
await Bun.write(
  resolve(root, `plugin-command-v${version}.bin`),
  encodePluginCommandIndex({
    schemaVersion: version,
    landoVersion: "0.0.0",
    pluginNames: ["@lando/fixture"],
    generatedAtMs: 1_700_000_200_000,
    entries: [{ id: "meta:fixture", summary: "Fixture plugin command", hidden: false }],
  }),
);
