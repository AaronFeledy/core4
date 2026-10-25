import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Redacted, Schema, Stream } from "effect";

import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  GlobalConfig,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  ConfigService,
  type ExecChunk,
  LandofileService,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ToolingEngine,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { execApp } from "../../src/operations/exec.ts";
import { followLogsForPlan } from "../../src/operations/logs.ts";
import * as ProviderExecToolingEngine from "../../src/services/tooling-engine.ts";
import { workerStatePath } from "../../src/subsystems/host-proxy/worker-state-file.ts";
import { outputRegisteredTestProvider } from "../../src/testing/output-provider.ts";

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
const plan: CurrentExecutableAppPlan = {
  valueModel: 1,
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
        environment: { DISPLAY_VALUE: "${secret:X}", DISPLAY_URL: "${secret:Y}" },
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
  readAppEnvironment: () => Effect.succeed([Redacted.make(password), Redacted.make(slashPassword)]),
  execStream: () =>
    Stream.fromIterable<ExecChunk>([
      { kind: "stdout", chunk: new TextEncoder().encode(bareLine.slice(0, 8)) },
      { kind: "stdout", chunk: new TextEncoder().encode(bareLine.slice(8)) },
      { kind: "stderr", chunk: new TextEncoder().encode(urlLine) },
      { exitCode: 0 },
    ]),
  logs: (target) =>
    Stream.make(
      { service: target.service, stream: "stdout" as const, line: bareLine },
      { service: target.service, stream: "stderr" as const, line: urlLine },
    ),
};
const registryLayer = Layer.succeed(
  RuntimeProviderRegistry,
  RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(outputRegisteredTestProvider(provider, plan)),
  }),
);
const makeSink = () => {
  const redaction = makeRedactionService();
  const redactionLayer = Layer.succeed(RedactionService, redaction);
  const io = createBufferedRendererIO();
  const layer = RendererOutput.layerStreamFrameSink("text").pipe(
    Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redactionLayer)),
  );
  return { io, layer: Layer.merge(layer, testEnvironmentResolverLayerFor(redaction)) };
};

describe("live plan-secret redaction", () => {
  test.each([
    [0o600, false, "[redacted]"],
    [0o640, false, "worker-transport-private-value"],
    [0o600, true, "worker-transport-private-value"],
  ] as const)(
    "worker credentials are trusted only for an owner-only matching app (%#)",
    async (mode, foreign, expected) => {
      const root = await mkdtemp(join(tmpdir(), "lando-output-worker-"));
      const paths = makeLandoPaths({ userDataRoot: root });
      const recordPath = workerStatePath(plan, paths.roots);
      const token = "worker-transport-private-value";
      const { io, layer } = makeSink();
      await mkdir(dirname(recordPath), { recursive: true });
      await writeFile(
        recordPath,
        JSON.stringify({
          appId: foreign ? "another-app" : plan.id,
          appRoot: plan.root,
          providerId: provider.id,
          protocolVersion: 2,
          pid: 123,
          transport: "unix-socket",
          socketPath: "/unused/socket",
          shimPath: "/unused/shim",
          startedAt: "2026-10-21T00:00:00Z",
          sessionId: "worker-session-private",
          token,
          controlToken: "worker-control-private",
          configDigest: "digest",
        }),
        { mode },
      );
      const workerProvider = {
        ...provider,
        readAppEnvironment: () => Effect.succeed([]),
        execStream: () =>
          Stream.make(
            { kind: "stdout" as const, chunk: new TextEncoder().encode(`${token}\n`) },
            { exitCode: 0 },
          ),
      };
      const config = Schema.decodeUnknownSync(GlobalConfig)({});
      const runtime = Layer.mergeAll(
        layer,
        PrivateFileAccessService.layer,
        Layer.succeed(PathsService, paths),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(provider.capabilities),
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          select: () => Effect.succeed(outputRegisteredTestProvider(workerProvider, plan)),
        }),
        Layer.succeed(
          LandofileService,
          LandofileService.of({ discover: Effect.succeed(literalTestLandofile({ name: plan.name })) }),
        ),
        Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
        Layer.succeed(
          ConfigService,
          ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
        ),
      );
      try {
        await Effect.runPromise(
          execApp({ service: "database", command: ["printenv", "LANDO_HOST_PROXY_TOKEN"] }).pipe(
            Effect.provide(runtime),
          ),
        );
        expect(io.stdout()).toBe(`${expected}\n`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  test("provider read failure fails closed before log output", async () => {
    const { io, layer } = makeSink();
    const failure = new ProviderUnavailableError({
      providerId: provider.id,
      operation: "readAppEnvironment",
      message: "Read denied.",
    });
    const failedProvider = { ...provider, readAppEnvironment: () => Effect.fail(failure) };
    const result = await Effect.runPromise(
      Effect.result(
        followLogsForPlan(plan).pipe(
          Effect.provide(
            Layer.merge(
              layer,
              Layer.succeed(RuntimeProviderRegistry, {
                list: Effect.succeed([providerId]),
                capabilities: Effect.succeed(provider.capabilities),
                appliedPlansFor: () => Effect.succeed([]),
                resolveAppliedPlan: () => Effect.succeed(undefined),
                resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
                select: () => Effect.succeed(outputRegisteredTestProvider(failedProvider, plan)),
              }),
            ),
          ),
        ),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUnavailableError", operation: "readAppEnvironment" },
    });
    expect(io.stdout() + io.stderr()).toBe("");
  });
  test("exec redacts plan passwords in the real stream sink", async () => {
    // Given: a sink built before exec resolves a plan whose passwords are absent from the host environment.
    const { io, layer } = makeSink();
    const config = Schema.decodeUnknownSync(GlobalConfig)({});
    const runtime = Layer.mergeAll(
      registryLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({ discover: Effect.succeed(literalTestLandofile({ name: plan.name })) }),
      ),
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
    expect(io.stdout()).not.toContain("database stderr:");
    expect(io.stderr()).toContain("database stderr: postgresql://[redacted]@database:5432/app");
    expect(io.stderr()).not.toContain("database stdout:");
    expect(io.stdout() + io.stderr()).not.toContain(password);
    expect(io.stdout() + io.stderr()).not.toContain(slashPassword);
  });

  test("container tooling redacts plan passwords in the real stream sink", async () => {
    // Given: provider-exec tooling and a sink built before the tooling command runs.
    const { io, layer } = makeSink();

    // When: container tooling streams provider output through the sink.
    await Effect.runPromise(
      Effect.flatMap(ToolingEngine, (engine) =>
        engine.run(
          { tool: "password", commands: [["printenv", "POSTGRES_PASSWORD"]] },
          plan,
          outputRegisteredTestProvider(provider, plan),
        ),
      ).pipe(Effect.provide(ProviderExecToolingEngine.layer), Effect.provide(layer)),
    );

    // Then: the live stdout and stderr contain redactions, never either plan password.
    expect(io.stdout()).toBe("[redacted]\n");
    expect(io.stderr()).toContain("[redacted]");
    expect(io.stdout() + io.stderr()).not.toContain(password);
    expect(io.stdout() + io.stderr()).not.toContain(slashPassword);
  });
});
import { literalTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayerFor } from "../environment-values.ts";
