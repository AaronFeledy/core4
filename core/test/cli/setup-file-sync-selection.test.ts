import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { FileSyncSelectionError, type FileSyncStartError } from "@lando/sdk/errors";
import type { HostPlatform } from "@lando/sdk/schema";
import { FileSyncEngine, PathsService } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";

import {
  type FileSyncCandidateDefinition,
  FileSyncResolver,
  type FileSyncResolverShape,
  type FileSyncSelectionPolicy,
} from "@lando/engine/plugins/file-sync-resolver";
import {
  type SetupReadinessRecorder,
  runFileSyncSetupStep,
} from "../../src/cli/command-specs/meta/setup-steps.ts";
import type { ResolvedSetupNetworkTrust } from "../../src/cli/commands/setup-network-trust.ts";
import type { SetupReadinessStep } from "../../src/cli/commands/setup-readiness.ts";

const network = {
  proxy: { noProxy: [], injectIntoServices: false },
  ca: { trustHost: true, certs: [], loadedCerts: [], injectIntoServices: true },
} satisfies ResolvedSetupNetworkTrust;

const slowProvider = { capabilities: { bindMountPerformance: "slow" as const } };
const nativeProvider = { capabilities: { bindMountPerformance: "native" as const } };

const makeRecorder = () => {
  const steps: SetupReadinessStep[] = [];
  const record = (step: SetupReadinessStep) =>
    Effect.sync(() => {
      steps.push(step);
    });
  const recorder: SetupReadinessRecorder = {
    record,
    recordFailure: (id, cause) =>
      record({
        id,
        status: "failed",
        evidence: cause instanceof Error ? cause.message : String(cause),
        remediation: "retry",
      }),
    recordUnavailable: (id, serviceName) =>
      record({
        id,
        status: "unavailable",
        evidence: `${serviceName} setup service is not available.`,
        remediation: "install an engine",
      }),
    setRuntimeService: () => undefined,
  };
  return { recorder, steps };
};

const candidate = (id: string): FileSyncCandidateDefinition => ({
  id,
  pluginName: `@example/${id}`,
  source: "explicit",
  supports: { platform: ["linux", "darwin", "win32"] },
  capabilities: {
    modes: ["two-way-safe"],
    remoteAgentDeployment: "none",
    exclusionPatterns: true,
    conflictReporting: false,
    progressReporting: false,
  },
});

type TrackingResolver = FileSyncResolverShape & {
  readonly selects: FileSyncSelectionPolicy[];
  readonly acquires: string[];
};

const makeResolver = (input: {
  readonly select?: (
    policy: FileSyncSelectionPolicy,
  ) => Effect.Effect<FileSyncCandidateDefinition | undefined, FileSyncSelectionError>;
  readonly acquire?: (id: string) => Effect.Effect<typeof TestFileSyncEngine, FileSyncStartError>;
  readonly candidates?: ReadonlyArray<FileSyncCandidateDefinition>;
}): TrackingResolver => {
  const selects: FileSyncSelectionPolicy[] = [];
  const acquires: string[] = [];
  const shape: TrackingResolver = {
    candidates: input.candidates ?? [candidate("alt-engine")],
    selects,
    acquires,
    select: (policy) => {
      selects.push(policy);
      return (
        input.select?.(policy) ??
        Effect.succeed(
          policy.bindMountPerformance === "native" || policy.defaultEngine === "passthrough"
            ? undefined
            : policy.defaultEngine !== undefined
              ? candidate(policy.defaultEngine)
              : candidate("alt-engine"),
        )
      );
    },
    acquire: (id) => {
      acquires.push(id);
      return (
        input.acquire?.(id) ??
        Effect.succeed(
          FileSyncEngine.of({
            ...TestFileSyncEngine,
            id,
            setup: () => Effect.void,
            isAvailable: Effect.succeed(true),
          }),
        )
      );
    },
  };
  return shape;
};

const pathsFor = (platform: HostPlatform = "linux") =>
  makeLandoPaths({ platform, userDataRoot: "/tmp/lando-setup-fs" });

describe("setup file-sync selection", () => {
  test.each(["unknown", "ambiguous"] as const)(
    "skip never selects or acquires a %s policy",
    async (reason) => {
      // Given
      const { recorder, steps } = makeRecorder();
      const resolver = makeResolver({
        select: () =>
          Effect.fail(
            new FileSyncSelectionError({
              reason,
              candidates: [],
              message: "Invalid selection",
              remediation: "Choose an engine",
            }),
          ),
      });
      // When
      const status = await Effect.runPromise(
        runFileSyncSetupStep({
          provider: slowProvider,
          input: { flags: { "skip-file-sync": true } },
          userDataRoot: undefined,
          network,
          recorder,
          ...(reason === "unknown" ? { defaultEngine: "missing" } : {}),
        }).pipe(
          Effect.provideService(FileSyncResolver, resolver),
          Effect.provideService(PathsService, pathsFor()),
        ),
      );
      // Then
      expect(status).toBe("deferred");
      expect(resolver.selects).toHaveLength(0);
      expect(resolver.acquires).toEqual([]);
      expect(steps.map(({ status }) => status)).toEqual(["deferred"]);
    },
  );

  test("native provider never selects or acquires an engine", async () => {
    const { recorder, steps } = makeRecorder();
    const resolver = makeResolver({});
    let factoryHits = 0;

    const status = await Effect.runPromise(
      runFileSyncSetupStep({
        provider: nativeProvider,
        input: {},
        userDataRoot: undefined,
        network,
        recorder,
      }).pipe(
        Effect.provideService(FileSyncResolver, {
          ...resolver,
          select: (policy) => {
            factoryHits += 1;
            return resolver.select(policy);
          },
          acquire: (id) => {
            factoryHits += 1;
            return resolver.acquire(id);
          },
        }),
        Effect.provideService(PathsService, pathsFor()),
      ),
    );

    expect(status).toBe("satisfied");
    expect(factoryHits).toBe(0);
    expect(steps.map(({ status: stepStatus }) => stepStatus)).toEqual(["satisfied"]);
  });

  test("passthrough default skips factory and setup", async () => {
    const { recorder, steps } = makeRecorder();
    const resolver = makeResolver({});
    let factoryHits = 0;

    const status = await Effect.runPromise(
      runFileSyncSetupStep({
        provider: slowProvider,
        input: {},
        userDataRoot: undefined,
        network,
        recorder,
        defaultEngine: "passthrough",
      }).pipe(
        Effect.provideService(FileSyncResolver, {
          ...resolver,
          select: (policy) => {
            factoryHits += 1;
            return resolver.select(policy);
          },
          acquire: (id) => {
            factoryHits += 1;
            return resolver.acquire(id);
          },
        }),
        Effect.provideService(PathsService, pathsFor()),
      ),
    );

    expect(status).toBe("satisfied");
    expect(factoryHits).toBe(0);
    expect(steps[0]?.evidence).toContain("passthrough");
  });

  test("slow provider with explicit alternative selects and sets up that id", async () => {
    const { recorder, steps } = makeRecorder();
    const setupCalls: string[] = [];
    const resolver = makeResolver({
      acquire: (id) =>
        Effect.succeed(
          FileSyncEngine.of({
            ...TestFileSyncEngine,
            id,
            setup: () =>
              Effect.sync(() => {
                setupCalls.push(id);
              }),
            isAvailable: Effect.succeed(true),
          }),
        ),
    });

    const status = await Effect.runPromise(
      runFileSyncSetupStep({
        provider: slowProvider,
        input: {},
        userDataRoot: undefined,
        network,
        recorder,
        defaultEngine: "alt-engine",
      }).pipe(
        Effect.provideService(FileSyncResolver, resolver),
        Effect.provideService(PathsService, pathsFor("linux")),
      ),
    );

    expect(status).toBe("installed");
    expect(resolver.selects).toEqual([
      { platform: "linux", bindMountPerformance: "slow", defaultEngine: "alt-engine" },
    ]);
    expect(resolver.acquires).toEqual(["alt-engine"]);
    expect(setupCalls).toEqual(["alt-engine"]);
    expect(steps.map(({ status: stepStatus }) => stepStatus)).toEqual(["installed"]);
  });

  test("configured resolver selection is not bypassed by an unrelated injected engine", async () => {
    const { recorder, steps } = makeRecorder();
    const setupCalls: string[] = [];
    const resolver = makeResolver({
      acquire: (id) =>
        Effect.succeed({
          ...TestFileSyncEngine,
          id,
          isAvailable: Effect.succeed(true),
          setup: () =>
            Effect.sync(() => {
              setupCalls.push(id);
            }),
        }),
    });
    const injected = FileSyncEngine.of({
      ...TestFileSyncEngine,
      id: "injected",
      setup: () =>
        Effect.sync(() => {
          setupCalls.push("injected");
        }),
      isAvailable: Effect.succeed(true),
    });

    const status = await Effect.runPromise(
      runFileSyncSetupStep({
        provider: slowProvider,
        input: {},
        userDataRoot: undefined,
        network,
        recorder,
        defaultEngine: "alt-engine",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSyncEngine, injected),
            Layer.succeed(FileSyncResolver, resolver),
            Layer.succeed(PathsService, pathsFor()),
          ),
        ),
      ),
    );

    expect(status).toBe("installed");
    expect(resolver.acquires).toEqual(["alt-engine"]);
    expect(setupCalls).toEqual(["alt-engine"]);
    expect(steps.map(({ status: stepStatus }) => stepStatus)).toEqual(["installed"]);
  });
});
