import { describe, expect, test } from "bun:test";

import { ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";

import { hostProviderIdFrom, resolveHostProviderSelection } from "../../src/providers/host-provider.ts";
import { GlobalConfigSources } from "../../src/services/config.ts";

describe("host provider selection", () => {
  test.each([false, true])("honors captured environment policy when env is %s", async (enabled) => {
    // Given: the live environment disagrees with the captured environment and configured provider.
    const previous = process.env.LANDO_PROVIDER;
    process.env.LANDO_PROVIDER = "docker";
    try {
      // When: resolving against a runtime's captured source policy.
      const selected = await Effect.runPromise(
        hostProviderIdFrom(ProviderId.make("configured")).pipe(
          Effect.provideService(GlobalConfigSources, {
            env: { LANDO_PROVIDER: "podman" },
            sources: { user: false, env: enabled },
          }),
        ),
      );
      // Then: excluded env cannot leak in, and included env comes from the snapshot.
      expect(selected).toBe(ProviderId.make(enabled ? "podman" : "configured"));
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
      else process.env.LANDO_PROVIDER = previous;
    }
  });
  test("environment wins over configuration and configuration wins over default", () => {
    expect(
      resolveHostProviderSelection({ env: ProviderId.make("podman"), config: ProviderId.make("docker") }),
    ).toEqual({ providerId: ProviderId.make("podman"), source: "env" });
    expect(resolveHostProviderSelection({ config: ProviderId.make("docker") })).toEqual({
      providerId: ProviderId.make("docker"),
      source: "config",
    });
    expect(resolveHostProviderSelection({})).toEqual({
      providerId: ProviderId.make("lando"),
      source: "default",
    });
  });
});
