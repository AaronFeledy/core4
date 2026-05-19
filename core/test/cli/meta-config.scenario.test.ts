import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { config, renderConfigResult } from "../../src/cli/commands/config.ts";

const fakeConfigService = (overrides: Partial<{ userDataRoot: string; userConfRoot: string }>) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed((overrides as Record<string, unknown>)[key as string] as never),
    load: Effect.succeed({} as never),
  } as never);

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
});
