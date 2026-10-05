import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
  resetRegisteredRedactionValuesForTesting,
} from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";
import { AbsolutePath, AppId, type AppPlan, GlobalConfig, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  ConfigService,
  type ExecChunk,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ToolingEngine,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { execApp } from "../../src/operations/exec.ts";
import { followLogsForPlan } from "../../src/operations/logs.ts";
import * as ProviderExecToolingEngine from "../../src/services/tooling-engine.ts";

const password = "lando-1bd5b0ac12d8296a";
const slashPassword = "s3cr/et-pa55word";
const bareLine = `${password}\n`;
const urlLine = `postgresql://lando:${slashPassword}@database:5432/app\n`;
const serviceName = ServiceName.make("database");
const providerId = ProviderId.make(TestRuntimeProvider.id);
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-04T00:00:00Z"),
  source: "stream-plan-secret-redaction.test",
  runtime: 4 as const,
};
const plan: AppPlan = {
  id: AppId.make("stream-plan-secret-redaction"),
  name: "stream-plan-secret-redaction",
  slug: "stream-plan-secret-redaction",
  root: AbsolutePath.make("/tmp/stream-plan-secret-redaction"),
  provider: providerId,
  services: Object.fromEntries([
    [
      serviceName,
      {
        name: serviceName,
        type: "postgres",
        provider: providerId,
        primary: true,
        environment: { POSTGRES_PASSWORD: password, MYSQL_PASSWORD: slashPassword },
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    ],
  ]),
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const provider: RuntimeProviderShape = {
  ...TestRuntimeProvider,
  execStream: () =>
    Stream.fromIterable<ExecChunk>([
      { kind: "stdout", chunk: new TextEncoder().encode(bareLine) },
      { kind: "stderr", chunk: new TextEncoder().encode(urlLine) },
      { exitCode: 0 },
    ]),
  logs: (target) =>
    Stream.make(
      { service: target.service, stream: "stdout" as const, line: bareLine },
      { service: target.service, stream: "stderr" as const, line: urlLine },
    ),
};
const redactionLayer = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
  }),
);
const registryLayer = Layer.succeed(
  RuntimeProviderRegistry,
  RuntimeProviderRegistry.of({
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  }),
);
const makeSink = () => {
  const io = createBufferedRendererIO();
  const layer = RendererOutput.layerStreamFrameSink("text").pipe(
    Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redactionLayer)),
  );
  return { io, layer: Layer.merge(layer, redactionLayer) };
};

beforeEach(resetRegisteredRedactionValuesForTesting);
afterEach(resetRegisteredRedactionValuesForTesting);

describe("live plan-secret redaction", () => {
  test("exec redacts plan passwords in the real stream sink", async () => {
    // Given: a sink built before exec resolves a plan whose passwords are absent from the host environment.
    const { io, layer } = makeSink();
    const config = Schema.decodeUnknownSync(GlobalConfig)({});
    const runtime = Layer.mergeAll(
      registryLayer,
      Layer.succeed(LandofileService, LandofileService.of({ discover: Effect.succeed({ name: plan.name }) })),
      Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
      Layer.succeed(
        ConfigService,
        ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
      ),
      layer,
    );

    // When: exec streams a bare password and a URL containing a slash-bearing password.
    await Effect.runPromise(
      execApp({ service: "database", command: ["printenv", "POSTGRES_PASSWORD"] }).pipe(
        Effect.provide(runtime),
      ),
    );

    // Then: stdout and stderr redact both plan passwords before rendering them.
    expect(io.stdout()).toBe("[redacted]\n");
    expect(io.stderr()).toContain("[redacted]");
    expect(io.stdout() + io.stderr()).not.toContain(password);
    expect(io.stdout() + io.stderr()).not.toContain(slashPassword);
  });

  test("follow logs redacts plan passwords in the real stream sink", async () => {
    // Given: a retained plan and a sink whose redactor is constructed before log streaming.
    const { io, layer } = makeSink();

    // When: the plan-direct follow entry point drains provider logs into that sink.
    await Effect.runPromise(followLogsForPlan(plan).pipe(Effect.provide(Layer.merge(registryLayer, layer))));

    // Then: both log lines redact plan passwords, including the slash-bearing URL password.
    expect(io.stdout()).toContain("database stdout: [redacted]");
    expect(io.stdout()).toContain("database stderr: postgresql://[redacted]@database:5432/app");
    expect(io.stdout() + io.stderr()).not.toContain(password);
    expect(io.stdout() + io.stderr()).not.toContain(slashPassword);
  });

  test("container tooling redacts plan passwords in the real stream sink", async () => {
    // Given: provider-exec tooling and a sink built before the tooling command runs.
    const { io, layer } = makeSink();

    // When: container tooling streams provider output through the sink.
    await Effect.runPromise(
      Effect.flatMap(ToolingEngine, (engine) =>
        engine.run({ tool: "password", commands: [["printenv", "POSTGRES_PASSWORD"]] }, plan, provider),
      ).pipe(Effect.provide(ProviderExecToolingEngine.layer), Effect.provide(layer)),
    );

    // Then: the live stdout and stderr contain redactions, never either plan password.
    expect(io.stdout()).toBe("[redacted]\n");
    expect(io.stderr()).toContain("[redacted]");
    expect(io.stdout() + io.stderr()).not.toContain(password);
    expect(io.stdout() + io.stderr()).not.toContain(slashPassword);
  });
});
