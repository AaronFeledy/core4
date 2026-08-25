import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { ShellRunner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { installEngineComposition } from "../../src/composition.ts";
import { startHostProxyRunLandoSession } from "../../src/operations/start-host-proxy.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import type { HostProxyShimTarget } from "../../src/subsystems/host-proxy/transport-shim.ts";

const PREPARE_SPY_SOCKET = "prepare-spy";
const X64_TARGET = { os: "linux", arch: "x64" } as const satisfies HostProxyShimTarget;
const ARM64_TARGET = { os: "linux", arch: "arm64" } as const satisfies HostProxyShimTarget;
const unusedPort = async () => {
  throw new Error("unused landofile port in start-host-proxy test");
};
const landofileRuntimeInputs = {
  ports: {
    resolveUserCacheRoot: () => "/tmp/lando-start-host-proxy-cache",
    npmRecipeSource: { resolve: unusedPort },
    git: { clone: unusedPort },
    tarball: { fetch: unusedPort, extract: unusedPort },
    publication: { publish: unusedPort },
  },
  templates: { modules: [] },
};

const prepareCalls: HostProxyShimTarget[] = [];
const tempDirs: string[] = [];
const previousComposition = globalThis.__landoEngineCompositionInputs;

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00.000Z"),
  source: "start-host-proxy.test",
  runtime: 4 as const,
};

const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/srv/apps/demo") };

const servicePlan = (eligible: boolean): ServicePlan => ({
  name: ServiceName.make("appserver"),
  type: "node",
  provider: ProviderId.make("lando"),
  primary: true,
  environment: {},
  appMount: {
    source: AbsolutePath.make("/srv/apps/demo"),
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: eligible ? { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } } : {},
});

const planFor = (eligible: boolean): AppPlan => {
  const service = servicePlan(eligible);
  return {
    id: AppId.make("demo"),
    name: "demo",
    slug: "demo",
    root: AbsolutePath.make("/srv/apps/demo"),
    provider: ProviderId.make("lando"),
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const capabilitiesFor = (
  target: HostProxyShimTarget,
  hostReachability: ProviderCapabilities["hostReachability"],
): ProviderCapabilities => ({
  ...TestRuntimeProvider.capabilities,
  hostReachability,
  hostProxy: { containerTargets: [target] },
});

const runtimeLayer = Layer.mergeAll(
  EventServiceLive,
  Layer.succeed(RedactionService, {
    forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
  }),
  Layer.succeed(ShellRunner, {
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    run: () => Effect.die("unused shell run in start-host-proxy test"),
    runScript: () => Effect.die("unused shell runScript in start-host-proxy test"),
    interactive: () => Effect.die("unused shell interactive in start-host-proxy test"),
  }),
);

beforeEach(() => {
  prepareCalls.length = 0;
  const composition = {
    bundledPluginModules: [],
    builtInCommandIds: [],
    landofileRuntimeInputs,
    hostProxyWorkerEntry: () => ({
      execPath: "/tmp/lando-start-host-proxy-missing-exec",
      entryPath: undefined,
      bunSourceEntryPath: "/tmp/lando-start-host-proxy-missing-entry.ts",
    }),
    bunDevDistRoot: () => "/tmp/lando-start-host-proxy-empty-dist",
    prepareHostProxyShimArtifact: (target: HostProxyShimTarget) => {
      prepareCalls.push(target);
      return Effect.fail(
        new HostProxyTransportUnavailableError({
          message: "prepare-spy",
          socketPath: PREPARE_SPY_SOCKET,
          remediation: "prepare-spy",
        }),
      );
    },
  };
  installEngineComposition(composition);
});

afterEach(async () => {
  globalThis.__landoEngineCompositionInputs = previousComposition;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const isolatedRoots = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-start-host-proxy-"));
  tempDirs.push(root);
  return {
    userConfRoot: join(root, "conf"),
    userCacheRoot: join(root, "cache"),
    userDataRoot: join(root, "data"),
    systemPluginRoot: join(root, "system-plugins"),
    platform: "linux" as const,
    env: {},
  };
};

const runSession = (
  plan: AppPlan,
  capabilities: ProviderCapabilities,
  roots: Awaited<ReturnType<typeof isolatedRoots>>,
) => startHostProxyRunLandoSession(plan, app, capabilities, roots).pipe(Effect.provide(runtimeLayer));

const expectPrepareSpy = (exit: Exit.Exit<unknown, unknown>, target: HostProxyShimTarget): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  expect(prepareCalls).toEqual([target]);
  if (!Exit.isFailure(exit)) return;
  const error = Cause.failureOption(exit.cause);
  expect(Option.isSome(error)).toBe(true);
  if (Option.isNone(error)) return;
  expect(error.value).toBeInstanceOf(HostProxyTransportUnavailableError);
  if (!(error.value instanceof HostProxyTransportUnavailableError)) return;
  expect(error.value._tag).toBe("HostProxyTransportUnavailableError");
  expect(error.value.socketPath).toBe(PREPARE_SPY_SOCKET);
};

describe("startHostProxyRunLandoSession prepare port", () => {
  test("invokes the composition preparer with linux-x64 before worker spawn", async () => {
    // Given
    const roots = await isolatedRoots();
    const plan = planFor(true);
    const capabilities = capabilitiesFor(X64_TARGET, "emulated");

    // When
    const exit = await Effect.runPromiseExit(runSession(plan, capabilities, roots));

    // Then
    expectPrepareSpy(exit, X64_TARGET);
  });

  test("invokes the composition preparer with linux-arm64 before worker spawn", async () => {
    // Given
    const roots = await isolatedRoots();
    const plan = planFor(true);
    const capabilities = capabilitiesFor(ARM64_TARGET, "emulated");

    // When
    const exit = await Effect.runPromiseExit(runSession(plan, capabilities, roots));

    // Then
    expectPrepareSpy(exit, ARM64_TARGET);
  });

  test("skips the preparer when hostReachability is none", async () => {
    // Given
    const roots = await isolatedRoots();
    const plan = planFor(true);
    const capabilities = capabilitiesFor(X64_TARGET, "none");

    // When
    const session = await Effect.runPromise(runSession(plan, capabilities, roots));

    // Then
    expect(session).toBeUndefined();
    expect(prepareCalls).toEqual([]);
  });

  test("skips the preparer when no service is host-proxy eligible", async () => {
    // Given
    const roots = await isolatedRoots();
    const plan = planFor(false);
    const capabilities = capabilitiesFor(X64_TARGET, "emulated");

    // When
    const session = await Effect.runPromise(runSession(plan, capabilities, roots));

    // Then
    expect(session).toBeUndefined();
    expect(prepareCalls).toEqual([]);
  });
});
