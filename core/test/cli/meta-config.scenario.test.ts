import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { config, renderConfigResult } from "../../src/cli/commands/config.ts";

const fakeConfigService = (overrides: Partial<{ userDataRoot: string; userConfRoot: string }>) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed((overrides as Record<string, unknown>)[key as string] as never),
    load: Effect.succeed({} as never),
  } as never);

const withTempEnv = async <T>(vars: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-meta-config-"));
  const touched = new Set<string>(["LANDO_USER_CONF_ROOT", ...Object.keys(vars)]);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("LANDO_CONFIG__")) touched.add(name);
  }
  const previous = new Map<string, string | undefined>();
  for (const name of touched) previous.set(name, process.env[name]);
  try {
    for (const name of touched) delete process.env[name];
    process.env.LANDO_USER_CONF_ROOT = dir;
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    return await run(dir);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
};

describe("meta:config command", () => {
  test("returns the resolved global config as JSON", async () => {
    const result = await Effect.runPromise(
      config({ format: "json" }).pipe(
        Effect.provide(fakeConfigService({ userDataRoot: "/data", userConfRoot: "/conf" })),
      ),
    );
    const rendered = renderConfigResult(result);
    const parsed = JSON.parse(rendered);
    expect(parsed.userDataRoot).toBe("/data");
    expect(parsed.userConfRoot).toBe("/conf");
  });

  test("supports dot-path lookups via --path", async () => {
    const result = await Effect.runPromise(
      config({ path: "userDataRoot", format: "json" }).pipe(
        Effect.provide(fakeConfigService({ userDataRoot: "/data" })),
      ),
    );
    expect(JSON.parse(renderConfigResult(result))).toBe("/data");
  });

  test("get subcommand reads a single key", async () => {
    const result = await Effect.runPromise(
      config({ subcommand: "get", key: "userConfRoot", format: "table" }).pipe(
        Effect.provide(fakeConfigService({ userConfRoot: "/conf" })),
      ),
    );
    expect(renderConfigResult(result)).toContain("/conf");
  });

  test("write subcommands are deferred with structured remediation", async () => {
    const result = await Effect.runPromiseExit(
      config({ subcommand: "set", key: "foo", value: "bar" }).pipe(Effect.provide(fakeConfigService({}))),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const cause = JSON.stringify(result.cause);
      expect(cause).toContain("NotImplementedError");
      expect(cause).toContain("meta:config");
      expect(cause).toContain("Edit");
    }
  });

  test("telemetry off writes telemetry.enabled false and reports the effective config source", async () => {
    await withTempEnv({}, async (dir) => {
      const result = await Effect.runPromise(
        config({ subcommand: "telemetry", key: "off", format: "json" }).pipe(
          Effect.provide(fakeConfigService({})),
        ),
      );

      expect(JSON.parse(renderConfigResult(result))).toMatchObject({
        telemetry: { enabled: false, source: "config" },
        changed: true,
        policy: "docs/telemetry/retention.md",
      });
      expect(await readFile(join(dir, "config.yml"), "utf8")).toContain("enabled: false");
    });
  });

  test("telemetry status reports env override ahead of config", async () => {
    await withTempEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "0" }, async (dir) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: true\n");

      const result = await Effect.runPromise(
        config({ subcommand: "telemetry", key: "status", format: "json" }).pipe(
          Effect.provide(fakeConfigService({})),
        ),
      );

      expect(JSON.parse(renderConfigResult(result))).toMatchObject({
        telemetry: { enabled: false, source: "env" },
        changed: false,
      });
    });
  });
});
