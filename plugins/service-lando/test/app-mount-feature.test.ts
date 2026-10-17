import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { composeService } from "@lando/engine/services/feature";
import { ServiceFeatureError } from "@lando/sdk/errors";
import { ProviderId, ServiceName } from "@lando/sdk/schema";

import { landoAppMountFeature } from "../src/features/app-mount.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

describe("lando.app-mount", () => {
  test("leaves the service unchanged when no target opts it in", async () => {
    // Given
    const { ctx, calls } = recordFeatureContext({ serviceType: "redis", normalizedConfig: {}, config: {} });

    // When
    await Effect.runPromise(landoAppMountFeature.apply(ctx));

    // Then
    expect(calls).toEqual([]);
  });

  test("merges authored mount intent when a default target opts it in", async () => {
    // Given
    const { ctx, calls } = recordFeatureContext({
      serviceType: "python",
      normalizedConfig: {
        appMount: {
          target: "/workspace/./",
          readOnly: false,
          excludes: ["cache", "vendor"],
          syncExcludes: ["logs", "cache"],
          includes: ["src"],
        },
      },
      config: {
        target: "/app",
        readOnly: true,
        excludes: ["cache", ".venv"],
        syncExcludes: ["cache"],
        includes: ["assets", "src", "assets"],
      },
    });

    // When
    await Effect.runPromise(landoAppMountFeature.apply(ctx));

    // Then the single app-source intent carries the merged policy, without a mirror bind.
    expect(calls).toEqual([
      [
        "setAppMount",
        {
          source: "/srv/apps/myapp",
          target: "/workspace",
          readOnly: false,
          excludes: ["cache", ".venv", "vendor"],
          syncExcludes: ["cache", "logs"],
          includes: ["assets", "src"],
        },
      ],
      ["addEnv", "LANDO_APP_ROOT", "/workspace"],
      ["addEnv", "LANDO_PROJECT_MOUNT", "/workspace"],
      ["setWorkingDirectory", "/workspace"],
    ]);
  });

  test("realizes authored mounts in order when no default target opts it in", async () => {
    // Given
    const { ctx, calls } = recordFeatureContext({
      serviceType: "redis",
      normalizedConfig: {
        appMount: false,
        mounts: ["./config:/etc/redis:ro", { type: "tmpfs", target: "/scratch" }],
      },
      config: {},
    });

    // When
    await Effect.runPromise(landoAppMountFeature.apply(ctx));

    // Then
    expect(calls).toEqual([
      ["addMount", { type: "bind", source: "/srv/apps/myapp/config", target: "/etc/redis", readOnly: true }],
      ["addMount", { type: "tmpfs", target: "/scratch", readOnly: false }],
    ]);
  });

  test.each([
    { target: 42 },
    { readOnly: "yes" },
    { excludes: [3] },
    { syncExcludes: [3] },
    { includes: [3] },
    { unexpected: true },
    { target: "/app", realization: "passthrough" },
  ])("rejects malformed feature config %j before applying it", async (config) => {
    // Given
    let applied = false;
    const definition = {
      ...landoAppMountFeature,
      apply: () =>
        Effect.sync(() => {
          applied = true;
        }),
    };
    // When
    const exit = await Effect.runPromiseExit(
      composeService({
        base: {
          name: ServiceName.make("web"),
          type: "test",
          provider: ProviderId.make("lando"),
          primary: true,
          defaultFeatures: [],
        },
        baseKind: "lando",
        appRoot: "/srv/project",
        normalizedConfig: {},
        features: [{ id: definition.id, definition, config }],
      }),
    );
    // Then
    expect(applied).toBe(false);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("Expected feature config validation failure");
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(ServiceFeatureError);
    if (!(error instanceof ServiceFeatureError)) throw new Error("Expected service feature error");
    expect(error.feature).toBe(landoAppMountFeature.id);
  });
});
