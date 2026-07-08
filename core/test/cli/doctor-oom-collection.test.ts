import { describe, expect, test } from "bun:test";
import { type Context, Effect, Layer } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import { OOM_CHECK_NAME } from "../../src/cli/commands/doctor-oom.ts";
import { doctor, renderDoctorResult, renderDoctorResultAsNdjson } from "../../src/cli/commands/doctor.ts";

const diedEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  Type: "container",
  Action: "died",
  Actor: {
    ID: "abc123",
    Attributes: {
      name: "lando-myapp-web",
      image: "docker.io/library/php:8.3",
      containerExitCode: "137",
      "dev.lando.app": "myapp",
      "dev.lando.service": "web",
    },
  },
  ...overrides,
});

const buildRegistry = (provider: typeof TestRuntimeProvider) => ({
  list: Effect.succeed([ProviderId.make(provider.id)]),
  capabilities: Effect.succeed(provider.capabilities),
  select: () => Effect.succeed(provider),
});

const buildConfigService = (): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const buildLayers = (provider: typeof TestRuntimeProvider) =>
  Layer.merge(
    Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
    Layer.succeed(ConfigService, buildConfigService()),
  );

describe("doctor collection of oom died events", () => {
  test("doctor consumes injected died-event payloads and appends redacted oom checks", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctor({
        diedEventPayloads: [
          diedEvent({
            OOMKilled: true,
            Actor: {
              Attributes: {
                name: "lando-x-web",
                image: "oci://user:s3cr3t@r.example.com/a",
                "dev.lando.app": "myapp",
                "dev.lando.service": "web",
              },
            },
          }),
          diedEvent(),
          { Type: "image", Action: "died" },
        ],
      }).pipe(Effect.provide(buildLayers(provider))),
    );

    const oomCheck = result.checks.find((check) => check.name === OOM_CHECK_NAME);
    expect(oomCheck).toBeDefined();
    expect(oomCheck?.providerKind).toBe("managed");
    expect(oomCheck?.context.app).toBe("myapp");
    expect(oomCheck?.context.service).toBe("web");

    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    expect(text).toContain(`${OOM_CHECK_NAME}: fail`);
    expect(ndjson).toContain('"oomKilled":true');
    expect(`${text}\n${ndjson}`).not.toContain("s3cr3t");
  });

  test("doctor consumes provider died-event payloads when the provider exposes them", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      getContainerDiedEvents: Effect.succeed([diedEvent({ OOMKilled: true })]),
    };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));

    expect(result.checks.some((check) => check.name === OOM_CHECK_NAME)).toBe(true);
  });
});
