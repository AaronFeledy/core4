import { describe, expect, test } from "bun:test";

import { ProviderId } from "@lando/sdk/schema";

import { resolveHostProviderSelection } from "../../src/providers/host-provider.ts";

describe("host provider selection", () => {
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
