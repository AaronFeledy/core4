import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { type ConfigOptions, ConfigResultSchema, config } from "../../src/operations/config.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";

let root = "";
const previous = new Map<string, string>();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-config-view-"));
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LANDO_") && value !== undefined) {
      previous.set(key, value);
      delete process.env[key];
    }
  }
  process.env.LANDO_USER_CONF_ROOT = root;
  process.env.LANDO_USER_DATA_ROOT = join(root, "data");
  process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
});
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("LANDO_")) delete process.env[key];
  for (const [key, value] of previous) process.env[key] = value;
  previous.clear();
  await rm(root, { recursive: true, force: true });
});
const run = (options: ConfigOptions) =>
  Effect.runPromise(config(options).pipe(Effect.provide(ConfigServiceLive)));

for (const [key, value] of [
  ["appEnv", { TEAM: "platform", MODE: "development" }],
  ["appLabels", { team: "platform", cost: "sandbox" }],
] as const) {
  test(`get returns ${key} when set persisted a map`, async () => {
    // Given
    await run({ subcommand: "set", key, value: JSON.stringify(value), type: "json" });
    // When
    const result = await run({ subcommand: "get", key });
    // Then
    expect(result.value).toEqual(value);
    expect(Schema.encodeSync(ConfigResultSchema)(result).value).toEqual(value);
  });
  test(`view preserves encoded ${key} when set persisted a map`, async () => {
    // Given
    const written = await run({ subcommand: "set", key, value: JSON.stringify(value), type: "json" });
    // When
    const result = await run({});
    // Then
    expect(result.config?.[key]).toEqual(value);
    expect(Schema.encodeSync(ConfigResultSchema)(result).config).toMatchObject({ [key]: value });
    expect(Schema.encodeSync(ConfigResultSchema)(written).value).toEqual(value);
  });
}

test("view excludes persisted internal bookkeeping when loading effective config", async () => {
  // Given: unknown bookkeeping must not become a public setting.
  await writeFile(
    join(root, "config.yml"),
    "setup:\n  completed: true\ntelemetry:\n  enabled: false\nappEnv:\n  TEAM: platform\n",
  );
  // When
  const result = await run({});
  // Then
  expect(result.config).not.toHaveProperty("setup");
  expect(result.config).toMatchObject({ telemetry: { enabled: false }, appEnv: { TEAM: "platform" } });
});

test("get preserves roots and telemetry when an adjacent scalar write is applied", async () => {
  // Given
  await run({ subcommand: "set", key: "telemetry.enabled", value: "false", type: "boolean" });
  // When
  const result = await run({ subcommand: "get", key: "telemetry.enabled" });
  // Then
  expect(result.value).toBe(false);
  expect(result.config).toMatchObject({
    userConfRoot: root,
    userDataRoot: join(root, "data"),
    userCacheRoot: join(root, "cache"),
  });
});
