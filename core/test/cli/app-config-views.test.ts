import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import {
  appConfigMcpSpecs,
  appConfigOptionsFromInput,
  appConfigSpec,
} from "../../src/cli/command-specs/app/config/index.ts";
import { AppConfigResultSchema, appConfig } from "../../src/cli/commands/app-config.ts";
import type { AppConfigOptions } from "../../src/cli/commands/app-config.ts";
import { testStateStoreLayer } from "../_support/landofile-layer.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-config-views-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const write = (name: string, content: string) => writeFile(join(dir, name), content);
const layer = Layer.merge(
  testStateStoreLayer,
  Layer.succeed(
    LandofileService,
    LandofileService.of({ discover: Effect.die("Raw and merged must not resolve the app.") }),
  ),
);
const run = (options: AppConfigOptions) =>
  Effect.runPromise(appConfig({ ...options, cwd: dir }).pipe(Effect.provide(layer)));

describe("raw and merged inspection", () => {
  test("exposes final-invalid authored layers without finalizing", async () => {
    await write(".lando.base.yml", "name: inspection\nservices:\n  web:\n    primary: true\n");
    await write(
      ".lando.yml",
      'services:\n  web:\n    primary: maybe\n    working_dir: /site\nx-deferred: "{{ load(./missing.yml) }}"\n',
    );
    const raw = await run({ source: "raw" });
    expect(raw).toMatchObject({
      source: "raw",
      layers: [
        { layer: "base", document: { services: { web: { primary: true } } } },
        { layer: "canonical", document: { services: { web: { working_dir: "/site", primary: "maybe" } } } },
      ],
    });
    await write(".lando.yml", "services:\n  web:\n    primary: maybe\n    working_dir: /site\n");
    const merged = await run({ source: "merged" });
    expect(merged).toMatchObject({
      source: "merged",
      landofile: { services: { web: { primary: "maybe", workingDirectory: "/site" } } },
    });
  });

  test.each([
    ["x-value", null],
    ["x-list", ["one", "two"]],
    ["x-list[1]", "two"],
    ["x-scalar", false],
  ])("projects each raw layer independently at %s", async (path, value) => {
    await write(".lando.base.yml", "name: inspection\nx-other: yes\n");
    await write(".lando.yml", "x-value: null\nx-list: [one, two]\nx-scalar: false\n");
    const result = await run({ source: "raw", path });
    expect(result).toMatchObject({
      source: "raw",
      path,
      layers: [{ layer: "base" }, { layer: "canonical", document: value }],
    });
    if (!("layers" in result)) throw new Error("Expected raw projection");
    expect(Object.hasOwn(result.layers[0] ?? {}, "document")).toBe(false);
  });

  test.each(["missing", "x-scalar.child", "x-list[8]", "x-list[no]", "constructor"])(
    "omits raw get value when every layer misses %s",
    async (key) => {
      await write(".lando.yml", "name: inspection\nx-scalar: false\nx-list: [one]\n");
      const result = await run({ source: "raw", subcommand: "get", key });
      expect(Object.hasOwn(result, "value")).toBe(false);
    },
  );

  test("raw get keeps miss layers when any layer matches, and path substitutes for key", async () => {
    await write(".lando.base.yml", "name: inspection\n");
    await write(".lando.yml", "x-count: 42\n");
    const result = await run({ source: "raw", subcommand: "get", path: "x-count" });
    expect(result).toMatchObject({
      source: "raw",
      subcommand: "get",
      key: "x-count",
      value: [{ layer: "base" }, { layer: "canonical", document: 42 }],
    });
  });

  test("retains the selector when every raw layer matches", async () => {
    await write(".lando.base.yml", "name: base\n");
    await write(".lando.yml", "name: canonical\n");
    expect(await run({ source: "raw", path: "name" })).toMatchObject({
      path: "name",
      layers: [{ document: "base" }, { document: "canonical" }],
    });
  });

  test("keeps directive payloads and escapes literal collisions", async () => {
    await write(
      ".lando.yml",
      "name: inspection\nx-remove: !reset\nx-replace: !override [a, b]\nx-literal:\n  _tag: LandofileReset\n",
    );
    expect(await run({ source: "raw" })).toMatchObject({
      layers: [
        {
          document: {
            "x-remove": { _tag: "LandofileReset" },
            "x-replace": { _tag: "LandofileOverride", value: ["a", "b"] },
            "x-literal": { _tag: "LandofileLiteral", value: { _tag: "LandofileReset" } },
          },
        },
      ],
    });
  });

  test("collects shadowed map, env-list and directive secrets before projection", async () => {
    await write(
      ".lando.base.yml",
      "name: inspection\nservices:\n  web:\n    environment: [PASSWORD=base-canary=with-equals]\nx-payload: !override\n  TOKEN: directive-canary\n",
    );
    await write(
      ".lando.yml",
      "services:\n  web:\n    environment:\n      PASSWORD: top-canary\nx-echo: base-canary=with-equals\n",
    );
    const result = await run({ source: "merged", path: "x-echo" });
    expect("redactionTokens" in result ? result.redactionTokens : []).toEqual(
      expect.arrayContaining(["base-canary=with-equals", "top-canary", "directive-canary"]),
    );
  });

  test("result schemas reject incomplete resolved views and malformed writes", () => {
    expect(Schema.is(AppConfigResultSchema)({ source: "resolved", landofile: { runtime: "invalid" } })).toBe(
      false,
    );
    expect(Schema.is(AppConfigResultSchema)({ source: "resolved" })).toBe(false);
    expect(Schema.is(AppConfigResultSchema)({ subcommand: "set", filePath: "a", changed: true })).toBe(false);
  });

  test("MCP projections forward source/path and keep get key optional", async () => {
    await write(".lando.yml", "name: inspection\n");
    expect(appConfigOptionsFromInput({ flags: { source: "raw", path: "name" } })).toMatchObject({
      source: "raw",
      path: "name",
    });
    const get = appConfigMcpSpecs.find((spec) => spec.id === "app:config:get");
    expect(get?.args?.key?.required).toBe(false);
    expect(
      appConfigMcpSpecs.every((spec) => spec.flags?.source !== undefined && spec.flags?.path !== undefined),
    ).toBe(true);
    expect(appConfigSpec.documentOutput?.when?.({ flags: { source: "raw" } })).toBe(false);
    expect(appConfigSpec.documentOutput?.when?.({ flags: { path: "name" } })).toBe(false);
  });
});
