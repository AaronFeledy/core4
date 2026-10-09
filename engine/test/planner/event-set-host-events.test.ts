import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { ConfigError, LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, type ProviderCapabilities, validationIssue } from "@lando/sdk/schema";
import { ConfigService, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import { planApp } from "../../src/planner/assemble.ts";

const missingPlugin = (id: string) =>
  new PluginLoadError({ message: `Plugin ${id} is not registered.`, pluginName: id });

const pluginRegistry = PluginRegistry.of({
  list: Effect.succeed([]),
  load: (pluginName) => Effect.fail(missingPlugin(pluginName)),
  loadServiceType: (id) => Effect.fail(missingPlugin(id)),
  loadServiceFeature: (id) => Effect.fail(missingPlugin(id)),
  loadAppFeature: (id) => Effect.fail(missingPlugin(id)),
});

describe("event-set global config load failures", () => {
  test("keeps the real issue path instead of blaming network injection", async () => {
    const configService = ConfigService.of({
      load: Effect.fail(
        new ConfigError({
          message: 'config.yml hostEvents.pre-start[0] cannot target a container. Use service: ":host".',
          path: "/tmp/config.yml",
          cause: {
            issues: [
              validationIssue(
                ["hostEvents", "pre-start", 0],
                'config.yml hostEvents.pre-start[0] cannot target a container. Use service: ":host".',
              ),
            ],
          },
        }),
      ),
      get: () => Effect.die("unused"),
    });
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "path-fix",
      services: { web: { type: "node:22", image: "alpine:3", home: false } },
    });
    const capabilities: ProviderCapabilities = TestRuntimeProvider.capabilities;
    const exit = await Effect.runPromiseExit(
      planApp(
        pluginRegistry,
        undefined,
        configService,
        undefined,
        undefined,
        undefined,
        landofile,
        capabilities,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected planner failure");
    const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(failure).toBeInstanceOf(LandofileValidationError);
    if (!(failure instanceof LandofileValidationError)) throw failure;
    expect(failure.issues[0]?.path).toEqual(["hostEvents", "pre-start", 0]);
    expect(failure.issues[0]?.path).not.toEqual(["network"]);
    expect(failure.message).toContain("hostEvents.pre-start[0]");
  });
});
