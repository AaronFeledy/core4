import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { landoAppMountFeature } from "../src/features/app-mount.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

describe("lando.app-mount", () => {
  test("leaves the service unchanged when no target opts it in", async () => {
    // Given a base-default feature with no mount config.
    const { ctx, calls } = recordFeatureContext({ serviceType: "redis", normalizedConfig: {}, config: {} });

    // When the feature applies.
    await Effect.runPromise(landoAppMountFeature.apply(ctx));

    // Then no mount, environment, or working directory is contributed.
    expect(calls).toEqual([]);
  });

  test("merges authored mount intent when a default target opts it in", async () => {
    // Given distinct feature defaults and authored overrides.
    const { ctx, calls } = recordFeatureContext({
      serviceType: "python",
      normalizedConfig: {
        appMount: {
          target: "/workspace/./",
          readOnly: false,
          excludes: ["cache", "vendor"],
          includes: ["src"],
        },
      },
      config: { target: "/app", readOnly: true, excludes: ["cache", ".venv"], realization: "passthrough" },
    });

    // When the feature applies.
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
          includes: ["src"],
          realization: "passthrough",
        },
      ],
      ["addEnv", "LANDO_APP_ROOT", "/workspace"],
      ["addEnv", "LANDO_PROJECT_MOUNT", "/workspace"],
      ["setWorkingDirectory", "/workspace"],
    ]);
  });

  test("realizes authored mounts in order when no default target opts it in", async () => {
    // Given a data store with mixed authored mount syntax and no app-mount config.
    const { ctx, calls } = recordFeatureContext({
      serviceType: "redis",
      normalizedConfig: {
        appMount: false,
        mounts: ["./config:/etc/redis:ro", { type: "tmpfs", target: "/scratch" }],
      },
      config: {},
    });

    // When the feature applies.
    await Effect.runPromise(landoAppMountFeature.apply(ctx));

    // Then authored intent is realized once without app-source or process defaults.
    expect(calls).toEqual([
      ["addMount", { type: "bind", source: "/srv/apps/myapp/config", target: "/etc/redis", readOnly: true }],
      ["addMount", { type: "tmpfs", target: "/scratch", readOnly: false }],
    ]);
  });
});
