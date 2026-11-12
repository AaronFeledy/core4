import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
  type ServicePullPolicy,
} from "@lando/sdk/schema";
import {
  type ArtifactBuildSpec,
  type ArtifactPullSpec,
  BuildOrchestrator,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as StateStoreLayer from "@lando/state-store/service";
import { DateTime, Effect, Layer } from "effect";

import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import * as BuildOrchestratorLayer from "../../src/services/build-orchestrator.ts";
import * as LandoEventService from "../../src/services/event-service.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";

const providerId = ProviderId.make("test");
const ref = "debian:12.11-slim";
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "build-orchestrator-pull-policy.test",
  runtime: 4 as const,
};

const web = (input: {
  readonly artifact: NonNullable<ServicePlan["artifact"]>;
  readonly pullPolicy?: ServicePullPolicy | undefined;
  readonly extensions?: ServicePlan["extensions"];
}): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: input.artifact,
  ...(input.pullPolicy === undefined ? {} : { pullPolicy: input.pullPolicy }),
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: input.extensions ?? {},
});

const appPlan = (service: ServicePlan, id = "myapp"): AppPlan => ({
  id: AppId.make(id),
  name: "My App",
  slug: id,
  root: AbsolutePath.make(`/srv/apps/${id}`),
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const layer = (provider: RuntimeProviderShape) => {
  const dependencies = Layer.mergeAll(
    LandoEventService.layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
    StateStoreLayer.layer.pipe(Layer.provide(BunProcessRunner.layer)),
  );
  return Layer.mergeAll(dependencies, BuildOrchestratorLayer.layer.pipe(Layer.provide(dependencies)));
};

const registryFailure = new ProviderUnavailableError({
  providerId: "test",
  operation: "pullArtifact",
  message: "registry unavailable",
  remediation: "Check registry access, then retry.",
});

const pullingProvider = (pulls: ArtifactPullSpec[], fails: (spec: ArtifactPullSpec) => boolean) => ({
  ...TestRuntimeProvider,
  capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
  pullArtifact: (spec: ArtifactPullSpec) => {
    pulls.push(spec);
    return fails(spec) ? Effect.fail(registryFailure) : Effect.succeed({ providerId, ref: spec.ref });
  },
});

const build = (plan: AppPlan, provider: RuntimeProviderShape, refresh: boolean) =>
  Effect.runPromiseExit(
    Effect.flatMap(BuildOrchestrator, (orchestrator) =>
      orchestrator.build(plan, refresh ? { refresh: true } : undefined),
    ).pipe(Effect.provide(layer(provider))),
  );

describe("BuildOrchestrator pull_policy acquisition", () => {
  test.each([
    ["always", false],
    ["always", true],
    ["never", false],
    ["never", true],
  ] as const)(
    "Given pull_policy %s and refresh=%s, when built, then the policy is used once with the pinned platform",
    async (pullPolicy, refresh) => {
      // Given
      const pulls: ArtifactPullSpec[] = [];
      const service = web({
        artifact: { kind: "ref", ref },
        pullPolicy,
        extensions: { compose: { platform: "linux/arm64" } },
      });

      // When
      const exit = await build(
        appPlan(service),
        pullingProvider(pulls, () => false),
        refresh,
      );

      // Then
      expect(exit._tag).toBe("Success");
      expect(pulls).toEqual([{ ref, policy: pullPolicy, platform: "linux/arm64" }]);
    },
  );

  test.each([false, true])(
    "Given pull_policy always and refresh=%s, when the pull fails, then the build fails without a local fallback",
    async (refresh) => {
      // Given
      const pulls: ArtifactPullSpec[] = [];
      const service = web({ artifact: { kind: "ref", ref }, pullPolicy: "always" });

      // When
      const exit = await build(
        appPlan(service),
        pullingProvider(pulls, () => true),
        refresh,
      );

      // Then
      expect(exit._tag).toBe("Failure");
      expect(pulls).toEqual([{ ref, policy: "always" }]);
    },
  );

  test("Given pull_policy never on rebuild, when the image is missing locally, then the build fails without pulling", async () => {
    // Given
    const pulls: ArtifactPullSpec[] = [];
    const service = web({ artifact: { kind: "ref", ref }, pullPolicy: "never" });

    // When
    const exit = await build(
      appPlan(service),
      pullingProvider(pulls, (spec) => spec.policy === "never"),
      true,
    );

    // Then
    expect(exit._tag).toBe("Failure");
    expect(pulls).toEqual([{ ref, policy: "never" }]);
  });

  test.each([
    [undefined, ["web"]],
    ["build", ["web", "web"]],
  ] as const)(
    "Given a scratch Compose build with pull_policy %s, when built twice, then the builder runs %j",
    async (pullPolicy, expected) => {
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-pull-policy-")));
      const previous = { cache: process.env.LANDO_USER_CACHE_ROOT, data: process.env.LANDO_USER_DATA_ROOT };
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      process.env.LANDO_USER_DATA_ROOT = cacheRoot;
      try {
        // Given
        const context = join(cacheRoot, "context");
        await mkdir(context);
        await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
        const builds: string[] = [];
        const provider = {
          ...TestRuntimeProvider,
          buildArtifact: (spec: ArtifactBuildSpec) =>
            Effect.sync(() => {
              builds.push(String(spec.service));
              return { providerId, ref: `${spec.service}:built` };
            }),
        };
        const service = web({
          artifact: { kind: "build", context: AbsolutePath.make(context), contentHash: "sha256:context" },
          pullPolicy,
        });

        // When
        const scratchPlan = (id: string) => ({
          ...appPlan(service, id),
          extensions: { [SCRATCH_EXTENSION_KEY]: { id } },
        });
        await build(scratchPlan("scratch-pull-first"), provider, false);
        await build(scratchPlan("scratch-pull-second"), provider, false);

        // Then
        expect(builds).toEqual([...expected]);
      } finally {
        if (previous.cache === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
        else process.env.LANDO_USER_CACHE_ROOT = previous.cache;
        if (previous.data === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        else process.env.LANDO_USER_DATA_ROOT = previous.data;
        await rm(cacheRoot, { recursive: true, force: true });
      }
    },
  );
});
