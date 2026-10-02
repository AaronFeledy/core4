import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextContentDigest } from "@lando/container-runtime/image-build";
import { makeLandoPaths } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  BuildOrchestrator,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type StateBucketSpec,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { StateStoreLive } from "@lando/state-store/service";
import { DateTime, Effect, Layer } from "effect";
import { appBuildKeyForStep, buildKeyForService } from "../../src/services/build-key.ts";
import { BuildOrchestratorLive } from "../../src/services/build-orchestrator.ts";
import { openScratchBuildResults, recordBuildResult } from "../../src/services/build-results.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { ProcessRunnerLive } from "../../src/services/process-runner.ts";
import { CORE_VERSION } from "../../src/version.ts";

const provider = {
  ...TestRuntimeProvider,
  id: ProviderId.make("test"),
  version: "1.0.0",
  platform: "linux",
} satisfies RuntimeProviderShape;
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: provider.id,
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z"), source: "canonical", runtime: 4 },
  extensions: {},
};
const key = (input: ServicePlan) => Effect.runPromise(buildKeyForService(provider, input));

test("hashes independently specified UTF-16 bytes for provider environment tuples", async () => {
  const input = { ...service, environment: { a: "a", B: "B", é: "accent", "2": "two", "10": "ten" } };
  const fingerprint = await key(input);
  expect(fingerprint).toBe(
    sha256Hex(
      `{"landoVersion":${JSON.stringify(CORE_VERSION)},"provider":{"id":"test","platform":"linux","version":"1.0.0"},"service":{"buildSteps":[],"configSources":[],"environment":[["10","ten"],["2","two"],["B","B"],["a","a"],["é","accent"]],"mounts":[],"name":"web","type":"node"}}`,
    ),
  );
});

test("normalizes whole secret references while preserving embedded references verbatim", () => {
  const input = { service, stepId: "compile" };
  const whole = appBuildKeyForStep({ ...input, command: "${secret:TOKEN}" });
  const object = appBuildKeyForStep({ ...input, command: { secret: "TOKEN" } });
  const embedded = appBuildKeyForStep({ ...input, command: "echo ${secret:TOKEN}" });
  expect(whole).toBe(object);
  expect(embedded).not.toBe(appBuildKeyForStep({ ...input, command: "echo TOKEN" }));
  expect(embedded).toBe(
    sha256Hex(
      `{"command":"echo \u0024{secret:TOKEN}","landoVersion":${JSON.stringify(CORE_VERSION)},"service":{"environment":[],"mounts":[],"name":"web"},"stepId":"compile"}`,
    ),
  );
});

test("sorts build-arg tuples by UTF-16 and normalizes only whole secret references", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-canonical-args-"));
  try {
    await writeFile(join(root, "Dockerfile"), "FROM alpine\n");
    const contentDigest = await buildContextContentDigest(root);
    const input: ServicePlan = {
      ...service,
      artifact: {
        kind: "build",
        context: AbsolutePath.make(root),
        args: { a: "embedded ${secret:TOKEN}", B: "${secret:TOKEN}", "2": "two", "10": "ten" },
      },
    };
    const fingerprint = await key(input);
    expect(fingerprint).toBe(
      sha256Hex(
        `{"landoVersion":${JSON.stringify(CORE_VERSION)},"provider":{"id":"test","platform":"linux","version":"1.0.0"},"service":{"artifact":{"args":[["10","ten"],["2","two"],["B",{"secret":"TOKEN"}],["a","embedded \u0024{secret:TOKEN}"]],"contentDigest":${JSON.stringify(contentDigest)},"kind":"build"},"buildSteps":[],"configSources":[],"environment":[],"mounts":[],"name":"web","type":"node"}}`,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves command order when artifact inputs have the same tokens", async () => {
  const original = await key({ ...service, command: ["serve", "web"] });
  const reordered = await key({ ...service, command: ["web", "serve"] });
  expect(reordered).not.toBe(original);
});

test("preserves mount order when artifact mounts have the same members", async () => {
  const mounts = ["a", "B"].map((name) => ({
    type: "bind" as const,
    source: `/host/${name}`,
    target: PortablePath.make(`/app/${name}`),
    readOnly: false,
    realization: "passthrough" as const,
  }));
  const original = await key({ ...service, mounts });
  const reordered = await key({ ...service, mounts: [...mounts].reverse() });
  expect(reordered).not.toBe(original);
});

test("preserves build-step order when artifact steps have the same members", async () => {
  const buildSteps = [
    { id: "a", phase: "build", command: "first" },
    { id: "B", phase: "build", command: "second" },
  ];
  const original = await key({ ...service, extensions: { "@lando/core/service-features": { buildSteps } } });
  const reordered = await key({
    ...service,
    extensions: { "@lando/core/service-features": { buildSteps: [...buildSteps].reverse() } },
  });
  expect(reordered).not.toBe(original);
});

test("sorts config source keys by UTF-16 while retaining their content digests", async () => {
  const configSources = [
    { key: "a", digest: "first" },
    { key: "B", digest: "second" },
  ];
  const fingerprint = await key({
    ...service,
    extensions: { "@lando/core/service-features": { configSources } },
  });
  expect(fingerprint).toBe(
    sha256Hex(
      `{"landoVersion":${JSON.stringify(CORE_VERSION)},"provider":{"id":"test","platform":"linux","version":"1.0.0"},"service":{"buildSteps":[],"configSources":[{"digest":"second","key":"B"},{"digest":"first","key":"a"}],"environment":[],"mounts":[],"name":"web","type":"node"}}`,
    ),
  );
});

test("does not skip the provider when a version-1 persisted build result has the old changed key", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-canonical-build-"));
  try {
    const oldKey = sha256Hex(
      `{"landoVersion":${JSON.stringify(CORE_VERSION)},"provider":{"id":"test","platform":"linux","version":"1.0.0"},"service":{"buildSteps":[],"configSources":[],"environment":[["a","a"],["B","B"]],"mounts":[],"name":"web","type":"node"}}`,
    );
    const input = { ...service, environment: { a: "a", B: "B" } };
    expect(await key(input)).not.toBe(oldKey);
    let builds = 0;
    const runtime = {
      ...provider,
      buildArtifact: () =>
        Effect.sync(() => {
          builds += 1;
          return { providerId: provider.id, ref: "web:fresh" };
        }),
    };
    const paths = Layer.succeed(PathsService, makeLandoPaths({ userCacheRoot: root, userDataRoot: root }));
    const store = Layer.effect(
      StateStore,
      Effect.map(StateStore, (live) => ({
        ...live,
        open: <A, I>(spec: StateBucketSpec<A, I>) =>
          live.open({ ...spec, root: { path: AbsolutePath.make(root) } }),
      })),
    ).pipe(Layer.provide(StateStoreLive.pipe(Layer.provide(ProcessRunnerLive))));
    const dependencies = Layer.mergeAll(
      paths,
      store,
      EventServiceLive,
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([provider.id]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(runtime),
      }),
    );
    const layer = Layer.mergeAll(dependencies, BuildOrchestratorLive.pipe(Layer.provide(dependencies)));
    const plan: AppPlan = {
      id: AppId.make("scratch-canonical"),
      name: "scratch-canonical",
      slug: "scratch-canonical",
      root: AbsolutePath.make(root),
      provider: provider.id,
      services: { [service.name]: input },
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata: service.metadata,
      extensions: {},
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* openScratchBuildResults(yield* StateStore);
        yield* recordBuildResult(bucket, {
          buildKey: oldKey,
          service: service.name,
          phase: "artifact",
          outcome: "complete",
          exitCode: 0,
          durationMs: 1,
          artifactRef: "web:old",
          transcriptPath: AbsolutePath.make(join(root, "old.log")),
        });
      }).pipe(Effect.provide(dependencies)),
    );
    const built = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(plan)).pipe(
        Effect.provide(layer),
      ),
    );
    expect(builds).toBe(1);
    expect(built.services[service.name]?.artifact).toEqual({ kind: "ref", ref: "web:fresh" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
