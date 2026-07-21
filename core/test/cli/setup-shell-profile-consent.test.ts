import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ConfigService, PrivilegeService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { type GlobalConfig, ProviderId } from "@lando/sdk/schema";

import { setupSpec } from "../../src/cli/oclif/commands/meta/setup.ts";
import { HttpClient } from "../../src/http-client/service.ts";
import { makeTestHttpClient } from "../../src/testing/http-client.ts";

const runSetup = async (flags: Readonly<Record<string, unknown>>) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-setup-shell-consent-"));
  let providerSetupCalls = 0;
  let elevateCalls = 0;
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    setup: () =>
      Effect.sync(() => {
        providerSetupCalls += 1;
      }),
  };
  const registry = {
    list: Effect.succeed([ProviderId.make("lando")]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  };
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    userDataRoot,
  };
  const load = Effect.succeed(config);
  const privilege = {
    elevate: () =>
      Effect.sync(() => {
        elevateCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
  };

  try {
    await Effect.runPromise(
      setupSpec
        .run({ installDir: "/opt/lando", flags })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(RuntimeProviderRegistry, registry),
              Layer.succeed(ConfigService, { load, get: (key) => Effect.map(load, (value) => value[key]) }),
              Layer.succeed(HttpClient, makeTestHttpClient().service),
              Layer.succeed(PrivilegeService, privilege),
            ),
          ),
        ),
    );
    return { providerSetupCalls, elevateCalls };
  } finally {
    await rm(userDataRoot, { recursive: true, force: true });
  }
};

describe("meta:setup shell-profile consent", () => {
  test("skips shell-profile privilege calls when setup is non-interactive without yes", async () => {
    // Given non-interactive setup without approval, when provider setup succeeds.
    const calls = await runSetup({ "no-interactive": true });

    // Then setup completes without attempting privileged shell-profile integration.
    expect(calls).toEqual({ providerSetupCalls: 1, elevateCalls: 0 });
  });

  test("enable-linger does not approve shell-profile privilege calls in non-interactive setup", async () => {
    // Given optional linger is enabled without approving all defaults, when setup succeeds.
    const calls = await runSetup({ "enable-linger": true, "no-interactive": true });

    // Then linger does not change shell-profile consent.
    expect(calls).toEqual({ providerSetupCalls: 1, elevateCalls: 0 });
  });

  test("yes retains shell-profile integration in non-interactive setup", async () => {
    // Given non-interactive setup with explicit default approval, when setup succeeds.
    const calls = await runSetup({ yes: true, "no-interactive": true });

    // Then shell-profile integration retains its privileged call.
    expect(calls).toEqual({ providerSetupCalls: 1, elevateCalls: 1 });
  });

  test("interactive setup retains shell-profile integration", async () => {
    // Given the current interactive setup mode, when setup succeeds.
    const calls = await runSetup({});

    // Then shell-profile integration retains its privileged call.
    expect(calls).toEqual({ providerSetupCalls: 1, elevateCalls: 1 });
  });
});
