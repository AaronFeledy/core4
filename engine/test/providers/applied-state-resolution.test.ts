import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  ProviderId,
  type ResourceOwnershipMember,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { ListFilter, RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, DateTime, Effect, Exit } from "effect";

import {
  observeProviderRuntime,
  resolveAppliedPlanEvidence,
  resolveTeardownEvidence,
} from "../../src/providers/applied-state-resolution.ts";

const failureDetail = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (Exit.isSuccess(exit)) return undefined;
  const error = Cause.findErrorOption(exit.cause);
  return error._tag === "Some" ? (error.value as { readonly detail?: unknown }).detail : undefined;
};

const failureValue = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (Exit.isSuccess(exit)) return undefined;
  const error = Cause.findErrorOption(exit.cause);
  return error._tag === "Some" ? error.value : undefined;
};

const failureMessage = <A, E>(exit: Exit.Exit<A, E>): string => {
  const error = failureValue(exit);
  if (typeof error !== "object" || error === null || !("message" in error)) return "";
  return typeof error.message === "string" ? error.message : "";
};

const root = AbsolutePath.make("/tmp/applied-state-evidence");

test("per-app inventory damage does not poison readable plans or an unrelated cwd", async () => {
  const plan = planFor("docker");
  const damaged = {
    ...provider("docker", { appliedPlans: Effect.succeed([plan]) }),
    appliedStateInventory: Effect.succeed({
      plans: [plan],
      unreadable: [
        {
          reason: "unreadable" as const,
          appId: AppId.make("damaged-a"),
          path: "/tmp/isolated-state/damaged-a.json",
        },
      ],
    }),
  };
  expect(await Effect.runPromise(resolveTeardownEvidence(root, [damaged]))).toEqual({
    kind: "applied",
    plan,
  });
  expect(await Effect.runPromise(resolveAppliedPlanEvidence(root, [damaged]))).toEqual(plan);
  expect(
    await Effect.runPromise(resolveTeardownEvidence(AbsolutePath.make("/tmp/outside-app"), [damaged])),
  ).toEqual({ kind: "absent" });
});

test("an unreadable aggregate record does not poison another provider's app", async () => {
  const plan = planFor("docker");
  const aggregate = {
    ...provider("podman"),
    appliedStateInventory: Effect.succeed({
      plans: [],
      unreadable: [{ reason: "unreadable" as const, path: "/tmp/isolated-podman/applied-plans.json" }],
    }),
  };
  expect(
    await Effect.runPromise(
      resolveTeardownEvidence(root, [
        provider("docker", { appliedPlans: Effect.succeed([plan]) }),
        aggregate,
      ]),
    ),
  ).toEqual({ kind: "applied", plan });
});

test.each(["per-app", "record"] as const)(
  "%s inventory keeps protected cleanup hints enumerable without granting mutation authority",
  async (layout) => {
    const appId = AppId.make("damaged-a");
    const damaged = {
      ...provider("docker", { isAvailable: Effect.succeed(true) }),
      canCleanupOwnedResources: Effect.succeed(true),
      appliedStateInventory: Effect.succeed({
        plans: [],
        unreadable: [
          {
            reason: "unreadable" as const,
            path: "/tmp/isolated-state/applied.json",
            ...(layout === "per-app" ? { appId } : {}),
          },
        ],
      }),
      resourceOwnership: (requested: AbsolutePath) =>
        Effect.succeed(
          requested === root
            ? {
                appRoot: root,
                ownerKey: appIdentityKey("owner", root),
                providerId: ProviderId.make("docker"),
                appIds: [appId],
              }
            : undefined,
        ),
    };
    const failure = await Effect.runPromise(Effect.flip(resolveTeardownEvidence(root, [damaged])));
    expect(failure).toMatchObject({ _tag: "ProviderUnavailableError", operation: "applied-state.read" });
    expect(
      await Effect.runPromise(resolveTeardownEvidence(AbsolutePath.make("/tmp/outside-app"), [damaged])),
    ).toEqual({ kind: "absent" });
  },
);

test("unreadable applied state refuses teardown before label-owned resources can become orphans", async () => {
  const error = unavailable("docker", "applied-state.read");
  let observed = false;
  const damaged = provider("docker", {
    appliedPlans: Effect.fail(error),
    isAvailable: Effect.succeed(true),
    list: () =>
      Effect.sync(() => {
        observed = true;
        return [
          {
            providerId: ProviderId.make("docker"),
            app: AppId.make("damaged"),
            appRoot: root,
            service: ServiceName.make("web"),
            status: "running" as const,
            publications: { status: "unknown" as const },
          },
        ];
      }),
  });
  const failure = await Effect.runPromise(resolveTeardownEvidence(root, [damaged]).pipe(Effect.flip));
  expect(failure).toBe(error);
  expect(observed).toBe(false);
});

test.each(["per-app", "record"] as const)(
  "decision lookup refuses %s protected state at an independently owned root",
  async (layout) => {
    const appId = AppId.make("damaged-a");
    const damaged = {
      ...provider("docker", {
        isAvailable: Effect.succeed(true),
        list: () =>
          Effect.succeed([
            {
              providerId: ProviderId.make("docker"),
              app: appId,
              appRoot: root,
              service: ServiceName.make("web"),
              status: "running" as const,
              publications: { status: "unknown" as const },
            },
          ]),
      }),
      appliedStateInventory: Effect.succeed({
        plans: [],
        unreadable: [
          {
            reason: "unreadable" as const,
            path: "/tmp/isolated-state/applied.json",
            ...(layout === "per-app" ? { appId } : {}),
          },
        ],
      }),
      resourceOwnership: () =>
        Effect.succeed({
          appRoot: root,
          ownerKey: appIdentityKey("owner", root),
          providerId: ProviderId.make("docker"),
          appIds: [appId],
        }),
    };
    const failure = await Effect.runPromise(Effect.flip(resolveAppliedPlanEvidence(root, [damaged])));
    expect(failure).toMatchObject({ _tag: "ProviderUnavailableError", operation: "applied-state.read" });
  },
);

test("host info observes label-owned services with no applied plan when state is unreadable", async () => {
  const service = {
    providerId: ProviderId.make("docker"),
    app: AppId.make("damaged"),
    appRoot: root,
    service: ServiceName.make("web"),
    status: "running" as const,
    publications: { status: "unknown" as const },
  };
  const snapshots = await Effect.runPromise(
    observeProviderRuntime([
      provider("docker", {
        appliedPlans: Effect.fail(unavailable("docker", "applied-state.read")),
        isAvailable: Effect.succeed(true),
        list: () => Effect.succeed([service]),
        listVolumes: () => Effect.succeed([]),
      }),
    ]),
  );
  expect(snapshots).toEqual([
    {
      providerId: ProviderId.make("docker"),
      appliedPlans: [],
      runtimeObserved: true,
      services: [service],
      volumes: [],
    },
  ]);
});

test("applied provider A preserves failed provider B ownership in teardown evidence", async () => {
  // Given
  const hints = {
    appRoot: root,
    ownerKey: appIdentityKey("owner", root),
    providerId: ProviderId.make("docker"),
    appIds: [AppId.make("failed-b")],
  };
  const a = provider("lando", { appliedPlans: Effect.succeed([planFor("lando")]) });
  const b = {
    ...provider("docker", { isAvailable: Effect.succeed(true) }),
    resourceOwnership: () => Effect.succeed(hints),
    canCleanupOwnedResources: Effect.succeed(true),
  };
  // When
  const evidence = await Effect.runPromise(resolveTeardownEvidence(root, [a, b]));
  // Then
  expect(evidence).toEqual({ kind: "applied", plan: planFor("lando"), ownership: [hints] });
});

for (const problem of ["corrupt", "offline", "incapable"] as const) {
  test(`failed provider B ${problem} inventory refuses teardown before A can mutate`, async () => {
    // Given
    let aObserved = false;
    const a = provider("lando", {
      appliedPlans: Effect.succeed([planFor("lando")]),
      list: () =>
        Effect.sync(() => {
          aObserved = true;
          return [];
        }),
    });
    const b = {
      ...provider("docker", { isAvailable: Effect.succeed(problem !== "offline") }),
      resourceOwnership: () =>
        problem === "corrupt"
          ? Effect.fail(unavailable("docker", "resource-ownership"))
          : Effect.succeed({
              appRoot: root,
              ownerKey: appIdentityKey("owner", root),
              providerId: ProviderId.make("docker"),
              appIds: [AppId.make("failed-b")],
            }),
      canCleanupOwnedResources: Effect.succeed(problem !== "incapable"),
    };
    // When
    const exit = await Effect.runPromiseExit(resolveTeardownEvidence(root, [a, b]));
    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    expect(aObserved).toBe(false);
  });
}

for (const problem of ["corrupt", "offline", "incapable"] as const) {
  test(`applied provider A resolves without reading provider B's ${problem} inventory`, async () => {
    // Given
    const plan = planFor("lando");
    const a = provider("lando", { appliedPlans: Effect.succeed([plan]) });
    let inventoryReads = 0;
    const b = {
      ...provider("docker", { isAvailable: Effect.succeed(problem !== "offline") }),
      resourceOwnership: () => {
        inventoryReads += 1;
        return problem === "corrupt"
          ? Effect.fail(unavailable("docker", "resource-ownership"))
          : Effect.succeed({
              appRoot: root,
              ownerKey: appIdentityKey("owner", root),
              providerId: ProviderId.make("docker"),
              appIds: [AppId.make("failed-b")],
            });
      },
      canCleanupOwnedResources: Effect.succeed(problem !== "incapable"),
    };
    // When
    const resolved = await Effect.runPromise(resolveAppliedPlanEvidence(root, [a, b]));
    // Then
    expect(resolved).toEqual(plan);
    expect(inventoryReads).toBe(0);
  });
}

const destroyedApp = AppId.make("destroyed");

const recorded = (kind: ResourceOwnershipMember["kind"], nativeName: string): ResourceOwnershipMember => ({
  kind,
  nativeName,
  appId: destroyedApp,
  ...(kind === "container" ? { service: ServiceName.make("web") } : {}),
});

const ownershipOf = (providerId: string, members?: ReadonlyArray<ResourceOwnershipMember>) => ({
  appRoot: root,
  ownerKey: appIdentityKey("owner", root),
  providerId: ProviderId.make(providerId),
  appIds: [destroyedApp],
  ...(members === undefined ? {} : { members }),
});

const withOwnership = (base: RuntimeProviderShape, hints: ReturnType<typeof ownershipOf>) => ({
  ...base,
  resourceOwnership: () => Effect.succeed(hints),
  canCleanupOwnedResources: Effect.succeed(true),
});

const retainedVolume = {
  ref: { app: destroyedApp, store: "data" },
  identity: {
    coordinationKey: "lando:destroyed:data",
    nativeName: "lando-destroyed--web--storage--data",
    generation: "generation-1",
    ownerRoot: root,
    origin: "created" as const,
  },
};

const runningContainer = (name: string) => ({
  app: destroyedApp,
  appRoot: root,
  service: ServiceName.make("web"),
  providerId: ProviderId.make("docker"),
  containerId: `${name}-id`,
  nativeName: name,
  labels: {
    "dev.lando.app": "destroyed",
    "dev.lando.app-root": root,
    "dev.lando.service": "web",
    "dev.lando.provider": "docker",
  },
  status: "running" as const,
  publications: { status: "unknown" as const },
});

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  failureValue(exit) as { readonly detail?: unknown; readonly message: string; readonly remediation: string };

describe("resolveAppliedPlanEvidence without a matching plan", () => {
  test.each([
    {
      name: "a destroy that kept a data volume",
      members: [recorded("volume", retainedVolume.identity.nativeName)],
      volumes: [retainedVolume],
    },
    {
      name: "a recorded volume the runtime no longer holds",
      members: [recorded("volume", retainedVolume.identity.nativeName)],
      volumes: [],
    },
    {
      name: "a recorded private network without containers",
      members: [recorded("network", "lando-destroyed--default"), recorded("volume", "data")],
      volumes: [],
    },
    {
      name: "a recorded container the running runtime no longer reports",
      members: [recorded("container", "lando-destroyed--web"), recorded("volume", "data")],
      volumes: [],
    },
  ])("$name resolves as never applied", async ({ members, volumes }) => {
    const filters: ListFilter[] = [];
    const docker = withOwnership(
      provider("docker", {
        list: (filter) =>
          Effect.sync(() => {
            filters.push(filter);
            return [];
          }),
        listVolumes: () => Effect.succeed(volumes),
      }),
      ownershipOf("docker", members),
    );

    expect(await Effect.runPromise(resolveAppliedPlanEvidence(root, [docker], undefined, "exact"))).toBe(
      undefined,
    );
    expect(filters).toEqual([{ includeUnplanned: true }]);
  });

  test("teardown still receives the retained volumes a destroy kept", async () => {
    const hints = ownershipOf("docker", [recorded("volume", retainedVolume.identity.nativeName)]);
    const docker = withOwnership(
      provider("docker", { listVolumes: () => Effect.succeed([retainedVolume]) }),
      hints,
    );

    expect(await Effect.runPromise(resolveTeardownEvidence(root, [docker]))).toEqual({
      kind: "orphans",
      groups: [
        {
          providerId: ProviderId.make("docker"),
          appId: destroyedApp,
          services: [],
          volumes: [retainedVolume],
        },
      ],
      ownership: [hints],
    });
  });

  test("teardown attributes a volume two providers report to the provider that labelled it", async () => {
    // One runtime reachable through both providers, as when DOCKER_HOST points at the Podman socket.
    const labelled = { ...retainedVolume, labels: { "dev.lando.provider": "podman" } };
    const shared = { listVolumes: () => Effect.succeed([labelled]) };

    const evidence = await Effect.runPromise(
      resolveTeardownEvidence(root, [provider("docker", shared), provider("podman", shared)]),
    );

    expect(evidence).toEqual({
      kind: "orphans",
      groups: [
        { providerId: ProviderId.make("podman"), appId: destroyedApp, services: [], volumes: [labelled] },
      ],
    });
  });

  test("retained volumes resolve without observing a stopped runtime", async () => {
    const stopped = withOwnership(
      provider("docker", {
        isAvailable: Effect.succeed(false),
        list: () => Effect.die("a stopped runtime is never listed"),
        listVolumes: () => Effect.die("a stopped runtime is never listed"),
      }),
      ownershipOf("docker", [recorded("volume", "data"), recorded("network", "default")]),
    );

    expect(await Effect.runPromise(resolveAppliedPlanEvidence(root, [stopped]))).toBeUndefined();
  });

  test("a recorded container labelled for another data root resolves as never applied", async () => {
    const foreign = {
      ...runningContainer("lando-destroyed--web"),
      labels: {
        ...runningContainer("lando-destroyed--web").labels,
        [LANDO_DATA_ROOT_LABEL]: "/tmp/applied-state-peer-data",
      },
    };
    const docker = withOwnership(
      provider("docker", { list: () => Effect.succeed([foreign]) }),
      ownershipOf("docker", [recorded("container", "lando-destroyed--web")]),
    );

    expect(
      await Effect.runPromise(
        resolveAppliedPlanEvidence(root, [docker], undefined, "exact", "/tmp/applied-state-local-data"),
      ),
    ).toBeUndefined();
  });

  test("a recorded container the runtime still holds refuses and names it", async () => {
    const docker = withOwnership(
      provider("docker", { list: () => Effect.succeed([runningContainer("inventory-only-web")]) }),
      ownershipOf("docker", [recorded("container", "inventory-only-web"), recorded("volume", "data")]),
    );

    const failure = refusal(await Effect.runPromiseExit(resolveAppliedPlanEvidence(root, [docker])));

    expect(failure).toMatchObject({
      _tag: "AppResolveError",
      reason: "mismatch",
      detail: "provider-resources",
    });
    expect(failure.message).toContain("docker");
    expect(failure.message).toContain("inventory-only-web");
    expect(failure.remediation).toContain(root);
    expect(failure.remediation).toContain("`lando start`");
    expect(failure.remediation).toContain("`lando destroy --provider=docker --yes`");
  });

  test("a recorded container on a runtime Lando could not check refuses as unverified", async () => {
    const stopped = withOwnership(
      provider("docker", {
        isAvailable: Effect.succeed(false),
        list: () => Effect.die("a stopped runtime is never listed"),
      }),
      ownershipOf("docker", [recorded("container", "lando-destroyed--web")]),
    );

    const failure = refusal(await Effect.runPromiseExit(resolveAppliedPlanEvidence(root, [stopped])));

    expect(failure.detail).toBe("provider-resources");
    expect(failure.message).toContain("could not check the docker runtime (not running or not answering)");
    expect(failure.message).toContain("lando-destroyed--web");
  });

  test("an ownership record written for another root names the record to remove", async () => {
    const docker = withOwnership(provider("docker"), {
      ...ownershipOf("docker", [recorded("volume", "data")]),
      appRoot: AbsolutePath.make("/apps/elsewhere"),
    });

    const failure = refusal(await Effect.runPromiseExit(resolveAppliedPlanEvidence(root, [docker])));

    expect(failure.detail).toBe("provider-resources");
    expect(failure.message).toContain(`docker ownership record for ${root}`);
    expect(failure.remediation).toContain(`resource-ownership/${appIdentityKey("owner", root)}.json`);
    expect(failure.remediation).not.toContain("teardown");
  });

  test("an ownership hint without members still refuses", async () => {
    const docker = withOwnership(provider("docker"), ownershipOf("docker"));

    const failure = refusal(await Effect.runPromiseExit(resolveAppliedPlanEvidence(root, [docker])));

    expect(failure.detail).toBe("provider-resources");
    expect(failure.message).toContain("docker");
  });

  test("the refusal names at most five containers", async () => {
    const names = ["web-1", "web-2", "web-3", "web-4", "web-5", "web-6"];
    const docker = provider("docker", { list: () => Effect.succeed(names.map(runningContainer)) });

    const failure = refusal(await Effect.runPromiseExit(resolveAppliedPlanEvidence(root, [docker])));

    expect(failure.message).toContain("web-5 and 1 more");
    expect(failure.message).not.toContain("web-6");
  });

  test("a global app's refusal names only its destroy command", async () => {
    const docker = provider("docker", { list: () => Effect.succeed([runningContainer("global-web")]) });

    const failure = refusal(
      await Effect.runPromiseExit(
        resolveAppliedPlanEvidence(root, [docker], { kind: "global", id: "global" }, "exact"),
      ),
    );

    expect(failure.remediation).toContain("`lando global:destroy --provider=docker --yes`");
    expect(failure.remediation).not.toContain("lando start");
  });
});

test.each([
  {
    name: "host observation",
    run: (providers: ReadonlyArray<RuntimeProviderShape>) =>
      observeProviderRuntime(providers).pipe(Effect.asVoid),
    filter: { includeUnplanned: true },
  },
  {
    name: "exact teardown",
    run: (providers: ReadonlyArray<RuntimeProviderShape>) =>
      resolveTeardownEvidence(root, providers).pipe(Effect.asVoid),
    filter: { includeUnplanned: true },
  },
  {
    name: "ancestor resolution",
    run: (providers: ReadonlyArray<RuntimeProviderShape>) =>
      resolveAppliedPlanEvidence(root, providers).pipe(Effect.asVoid),
    filter: { includeUnplanned: true },
  },
])("$name uses the intended runtime discovery filter", async ({ run, filter }) => {
  const filters: ListFilter[] = [];
  await Effect.runPromise(
    run([
      provider("lando", {
        isAvailable: Effect.succeed(true),
        list: (input) => {
          filters.push(input);
          return Effect.succeed([]);
        },
      }),
    ]),
  );
  expect(filters).toEqual([filter]);
});

const provider = (
  id: string,
  options: {
    readonly appliedPlans?: RuntimeProviderShape["appliedPlans"];
    readonly isAvailable?: RuntimeProviderShape["isAvailable"];
    readonly list?: RuntimeProviderShape["list"];
    readonly listVolumes?: RuntimeProviderShape["listVolumes"];
  } = {},
): RuntimeProviderShape => ({
  ...TestRuntimeProvider,
  id,
  appliedPlans: options.appliedPlans ?? Effect.succeed([]),
  ...(options.isAvailable === undefined ? {} : { isAvailable: options.isAvailable }),
  list: options.list ?? (() => Effect.succeed([])),
  listVolumes: options.listVolumes ?? (() => Effect.succeed([])),
});

const unavailable = (providerId: string, operation: string) =>
  new ProviderUnavailableError({
    providerId,
    operation,
    message: `${providerId} evidence unavailable`,
    remediation: "Install or start the selected runtime provider, then re-run the failed command.",
  });

const planFor = (providerId: string): AppPlan => ({
  id: AppId.make("supplier-mismatch"),
  name: "supplier-mismatch",
  slug: "supplier-mismatch",
  root,
  identity: { appRoot: root, ownerKey: "supplier-mismatch-owner" },
  provider: ProviderId.make(providerId),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
    source: "applied-state-resolution.test",
    runtime: 4,
  },
  extensions: {},
});

test.each(["per-app", "record"] as const)(
  "teardown retains %s inventory protection so runtime resources do not become orphans",
  async (layout) => {
    const appId = AppId.make("damaged-a");
    const damaged = {
      ...provider("docker", {
        isAvailable: Effect.succeed(true),
        list: () =>
          Effect.succeed([
            {
              providerId: ProviderId.make("docker"),
              app: appId,
              appRoot: root,
              service: ServiceName.make("web"),
              status: "running" as const,
              publications: { status: "unknown" as const },
            },
          ]),
      }),
      appliedStateInventory: Effect.succeed({
        plans: [],
        unreadable: [
          {
            reason: "unreadable" as const,
            path: "/tmp/isolated-state/applied.json",
            ...(layout === "per-app" ? { appId } : {}),
          },
        ],
      }),
      resourceOwnership: () =>
        Effect.succeed({
          appRoot: root,
          ownerKey: appIdentityKey("owner", root),
          providerId: ProviderId.make("docker"),
          appIds: [appId],
        }),
      canCleanupOwnedResources: Effect.succeed(true),
    };
    const failure = await Effect.runPromise(Effect.flip(resolveTeardownEvidence(root, [damaged])));
    expect(failure).toMatchObject({ _tag: "ProviderUnavailableError", operation: "applied-state.read" });
  },
);

test.each(["per-app", "record"] as const)(
  "teardown retains newer-version %s inventory with upgrade protection, not orphan mutation",
  async (layout) => {
    const appId = AppId.make("newer-a");
    const damaged = {
      ...provider("docker", {
        isAvailable: Effect.succeed(true),
        list: () =>
          Effect.succeed([
            {
              providerId: ProviderId.make("docker"),
              app: appId,
              appRoot: root,
              service: ServiceName.make("web"),
              status: "running" as const,
              publications: { status: "unknown" as const },
            },
          ]),
      }),
      appliedStateInventory: Effect.succeed({
        plans: [],
        unreadable: [
          {
            reason: "newer-version" as const,
            path: "/tmp/isolated-state/applied.json",
            storedVersion: 11,
            supportedVersion: 10,
            ...(layout === "per-app" ? { appId } : {}),
          },
        ],
      }),
      resourceOwnership: () =>
        Effect.succeed({
          appRoot: root,
          ownerKey: appIdentityKey("owner", root),
          providerId: ProviderId.make("docker"),
          appIds: [appId],
        }),
      canCleanupOwnedResources: Effect.succeed(true),
    };
    const failure = await Effect.runPromise(Effect.flip(resolveTeardownEvidence(root, [damaged])));
    expect(failure).toMatchObject({ _tag: "AppliedStateVersionError", appId, storedVersion: 11 });
  },
);

test("protected inventory never infers an app root from the unreadable filename", async () => {
  const appId = AppId.make("damaged-a");
  const damaged = {
    ...provider("docker", { isAvailable: Effect.succeed(true) }),
    appliedStateInventory: Effect.succeed({
      plans: [],
      unreadable: [
        {
          reason: "unreadable" as const,
          appId,
          // Filename looks like another root; protection matches appId/provider only.
          path: "/tmp/other-app/damaged-a.json",
        },
      ],
    }),
    resourceOwnership: (requested: AbsolutePath) =>
      Effect.succeed(
        requested === root
          ? {
              appRoot: root,
              ownerKey: appIdentityKey("owner", root),
              providerId: ProviderId.make("docker"),
              appIds: [appId],
            }
          : undefined,
      ),
    canCleanupOwnedResources: Effect.succeed(true),
  };
  const failure = await Effect.runPromise(Effect.flip(resolveTeardownEvidence(root, [damaged])));
  expect(failure).toMatchObject({ _tag: "ProviderUnavailableError", operation: "applied-state.read" });
  expect(
    await Effect.runPromise(resolveTeardownEvidence(AbsolutePath.make("/tmp/other-app"), [damaged])),
  ).toEqual({ kind: "absent" });
});

test("an unreadable inventory on provider B does not block provider A's applied plan", async () => {
  const plan = planFor("lando");
  const a = provider("lando", { appliedPlans: Effect.succeed([plan]) });
  const b = {
    ...provider("docker"),
    appliedStateInventory: Effect.succeed({
      plans: [],
      unreadable: [
        {
          reason: "newer-version" as const,
          path: "/tmp/b/applied.json",
          storedVersion: 11,
          supportedVersion: 10,
        },
      ],
    }),
  };
  expect(await Effect.runPromise(resolveAppliedPlanEvidence(root, [a, b]))).toEqual(plan);
  expect(await Effect.runPromise(resolveTeardownEvidence(root, [a, b]))).toEqual({ kind: "applied", plan });
});

describe("observeProviderRuntime", () => {
  test.each([false, true])(
    "reports applied plans and observes only available runtimes: %s",
    async (available) => {
      const plan = planFor("lando");
      const service = {
        app: plan.id,
        appRoot: root,
        service: ServiceName.make("web"),
        providerId: plan.provider,
        status: "running" as const,
        publications: { status: "unknown" as const },
      };
      const volume = { ref: { app: plan.id, store: "data" } };
      const result = await Effect.runPromise(
        observeProviderRuntime([
          provider("lando", {
            appliedPlans: Effect.succeed([plan]),
            isAvailable: Effect.succeed(available),
            list: () => (available ? Effect.succeed([service]) : Effect.fail(unavailable("lando", "list"))),
            listVolumes: () =>
              available ? Effect.succeed([volume]) : Effect.fail(unavailable("lando", "listVolumes")),
          }),
          provider("docker", { isAvailable: Effect.succeed(false) }),
        ]),
      );
      expect(result).toEqual([
        {
          providerId: plan.provider,
          appliedPlans: [plan],
          runtimeObserved: available,
          services: available ? [service] : [],
          volumes: available ? [volume] : [],
        },
        {
          providerId: ProviderId.make("docker"),
          appliedPlans: [],
          runtimeObserved: false,
          services: [],
          volumes: [],
        },
      ]);
    },
  );

  test("rejects mismatched applied-plan attribution", async () => {
    const result = await Effect.runPromiseExit(
      observeProviderRuntime([provider("lando", { appliedPlans: Effect.succeed([planFor("docker")]) })]),
    );
    expect(failureDetail(result)).toBe("applied-state-provider");
  });

  test("propagates runtime listing failures", async () => {
    const result = await Effect.runPromiseExit(
      observeProviderRuntime([
        provider("lando", {
          isAvailable: Effect.succeed(true),
          list: () => Effect.fail(unavailable("lando", "list")),
        }),
      ]),
    );
    expect(String(result)).toContain("lando evidence unavailable");
  });

  test("keeps matching teardown runtime listing lazy", async () => {
    const plan = planFor("lando");
    const result = await Effect.runPromise(
      resolveTeardownEvidence(root, [
        provider("lando", {
          appliedPlans: Effect.succeed([plan]),
          isAvailable: Effect.fail(unavailable("lando", "availability")),
          list: () => Effect.fail(unavailable("lando", "list")),
        }),
      ]),
    );
    expect(result).toEqual({ kind: "applied", plan });
  });
});

describe("resolveAppliedPlanEvidence", () => {
  test("does not infer absence when no provider can supply evidence", async () => {
    const result = await Effect.runPromiseExit(resolveAppliedPlanEvidence(root, []));

    expect(result._tag).toBe("Failure");
    expect(failureDetail(result)).toBe("provider-evidence");
  });

  test("returns absence only after every provider confirms empty applied and runtime state", async () => {
    const result = await Effect.runPromise(
      resolveAppliedPlanEvidence(root, [provider("lando"), provider("docker")]),
    );

    expect(result).toBeUndefined();
  });

  test("skips runtime inspection for providers that are not available", async () => {
    const result = await Effect.runPromise(
      resolveAppliedPlanEvidence(root, [
        provider("lando"),
        provider("docker", {
          isAvailable: Effect.succeed(false),
          list: () => Effect.fail(unavailable("docker", "list")),
          listVolumes: () => Effect.fail(unavailable("docker", "listVolumes")),
        }),
      ]),
    );

    expect(result).toBeUndefined();
  });

  test("fails closed when one applied-state scan fails after another reports empty", async () => {
    const result = await Effect.runPromiseExit(
      resolveAppliedPlanEvidence(root, [
        provider("lando"),
        provider("docker", { appliedPlans: Effect.fail(unavailable("docker", "applied-state.list")) }),
      ]),
    );

    expect(result._tag).toBe("Failure");
    expect(String(result)).toContain("docker evidence unavailable");
  });

  test("rejects an applied plan attributed to a provider other than its supplier", async () => {
    const result = await Effect.runPromiseExit(
      resolveAppliedPlanEvidence(root, [
        provider("lando", { appliedPlans: Effect.succeed([planFor("docker")]) }),
      ]),
    );

    expect(result._tag).toBe("Failure");
    expect(failureDetail(result)).toBe("applied-state-provider");
  });

  test("does not report absence while a provider still exposes runtime services", async () => {
    const result = await Effect.runPromiseExit(
      resolveAppliedPlanEvidence(root, [
        provider("lando", {
          list: () =>
            Effect.succeed([
              {
                app: AppId.make("orphaned-app"),
                appRoot: root,
                service: ServiceName.make("appserver"),
                providerId: ProviderId.make("lando"),
                status: "running" as const,
                publications: { status: "unknown" as const },
              },
            ]),
        }),
      ]),
    );

    expect(result._tag).toBe("Failure");
    expect(failureDetail(result)).toBe("provider-resources");
    expect(failureMessage(result)).toContain("appserver (app orphaned-app)");
  });

  test("ignores runtime services owned by another app root", async () => {
    const result = await Effect.runPromise(
      resolveAppliedPlanEvidence(root, [
        provider("lando", {
          list: () =>
            Effect.succeed([
              {
                app: AppId.make("other-app"),
                appRoot: AbsolutePath.make("/tmp/other-app"),
                service: ServiceName.make("appserver"),
                providerId: ProviderId.make("lando"),
                status: "running" as const,
                publications: { status: "unknown" as const },
              },
            ]),
        }),
      ]),
    );

    expect(result).toBeUndefined();
  });

  test("propagates provider runtime evidence failures", async () => {
    const result = await Effect.runPromiseExit(
      resolveAppliedPlanEvidence(root, [
        provider("lando", { list: () => Effect.fail(unavailable("lando", "list")) }),
      ]),
    );

    expect(result._tag).toBe("Failure");
    expect(String(result)).toContain("lando evidence unavailable");
  });
});

describe("resolveTeardownEvidence", () => {
  test("reports absence when every provider confirms empty applied and runtime state", async () => {
    const result = await Effect.runPromise(
      resolveTeardownEvidence(root, [provider("lando"), provider("docker")]),
    );

    expect(result).toEqual({ kind: "absent" });
  });

  test("reports the applied plan that owns the root", async () => {
    const plan = planFor("lando");
    const result = await Effect.runPromise(
      resolveTeardownEvidence(root, [provider("lando", { appliedPlans: Effect.succeed([plan]) })]),
    );

    expect(result).toEqual({ kind: "applied", plan });
  });

  test("adopts runtime services the shared resolver refuses", async () => {
    const service = {
      app: AppId.make("orphaned-app"),
      appRoot: root,
      service: ServiceName.make("appserver"),
      providerId: ProviderId.make("lando"),
      containerId: "orphan-container",
      labels: {
        "dev.lando.app": "orphaned-app",
        "dev.lando.app-root": root,
        "dev.lando.service": "appserver",
      },
      status: "running" as const,
      publications: { status: "unknown" as const },
    };
    const result = await Effect.runPromise(
      resolveTeardownEvidence(root, [provider("lando", { list: () => Effect.succeed([service]) })]),
    );

    expect(result).toEqual({
      kind: "orphans",
      groups: [
        {
          providerId: ProviderId.make("lando"),
          appId: AppId.make("orphaned-app"),
          services: [service],
          volumes: [],
        },
      ],
    });
  });

  test.each([
    ["provider", { "dev.lando.provider": "docker" }],
    ["owner", { "dev.lando.owner": "other-owner" }],
    ["role", { "dev.lando.role": "data-helper" }],
    ["scratch", { "dev.lando.scratch": "TRUE" }],
  ] as const)("refuses orphan evidence with a contradictory %s label", async (_label, extra) => {
    // Given a container that claims this root but whose own labels contradict its identity.
    const service = {
      app: AppId.make("orphaned-app"),
      appRoot: root,
      service: ServiceName.make("appserver"),
      providerId: ProviderId.make("lando"),
      containerId: "contradictory-container",
      labels: {
        "dev.lando.app": "orphaned-app",
        "dev.lando.app-root": root,
        "dev.lando.service": "appserver",
        ...extra,
      },
      status: "running" as const,
      publications: { status: "unknown" as const },
    };
    // When
    const exit = await Effect.runPromiseExit(
      resolveTeardownEvidence(root, [provider("lando", { list: () => Effect.succeed([service]) })]),
    );
    // Then the evidence refuses instead of reporting absent or handing over a removable orphan.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureValue(exit)).toMatchObject({ _tag: "AppResolveError", detail: "provider-resources" });
    expect(failureMessage(exit)).toContain("contradictory-container");
    expect(failureMessage(exit)).toContain(Object.keys(extra)[0] ?? "");
  });

  test("adopts an owned volume the shared resolver refuses", async () => {
    const volume = {
      ref: { app: AppId.make("orphaned-app"), store: "database" },
      identity: {
        coordinationKey: "lando:orphaned-app:database",
        nativeName: "orphaned-app_database",
        generation: "generation-1",
        ownerRoot: root,
        origin: "created" as const,
      },
    };
    const result = await Effect.runPromise(
      resolveTeardownEvidence(root, [provider("lando", { listVolumes: () => Effect.succeed([volume]) })]),
    );

    expect(result).toEqual({
      kind: "orphans",
      groups: [
        {
          providerId: ProviderId.make("lando"),
          appId: AppId.make("orphaned-app"),
          services: [],
          volumes: [volume],
        },
      ],
    });
  });

  test("ignores runtime resources owned by another app root", async () => {
    const result = await Effect.runPromise(
      resolveTeardownEvidence(root, [
        provider("lando", {
          list: () =>
            Effect.succeed([
              {
                app: AppId.make("other-app"),
                appRoot: AbsolutePath.make("/tmp/other-app"),
                service: ServiceName.make("appserver"),
                providerId: ProviderId.make("lando"),
                status: "running" as const,
                publications: { status: "unknown" as const },
              },
            ]),
        }),
      ]),
    );

    expect(result).toEqual({ kind: "absent" });
  });

  test("matches exact-teardown ownership through a symlink alias of the root", async () => {
    const realRoot = await mkdtemp(join(tmpdir(), "lando-applied-teardown-alias-"));
    const alias = join(dirname(realRoot), `alias-${basename(realRoot)}`);
    try {
      await symlink(realRoot, alias, "dir");
      const canonical = AbsolutePath.make(await realpath(realRoot));
      const planned = {
        ...planFor("lando"),
        root: canonical,
        identity: { appRoot: canonical, ownerKey: appIdentityKey("owner", canonical) },
      };
      const hints = {
        appRoot: canonical,
        ownerKey: appIdentityKey("owner", canonical),
        providerId: ProviderId.make("docker"),
        appIds: [AppId.make("failed-b")],
      };
      const a = provider("lando", { appliedPlans: Effect.succeed([planned]) });
      const ownershipRoots: AbsolutePath[] = [];
      const b = {
        ...provider("docker", { isAvailable: Effect.succeed(true) }),
        resourceOwnership: (root: AbsolutePath) => {
          ownershipRoots.push(root);
          return Effect.succeed(root === canonical ? hints : undefined);
        },
        canCleanupOwnedResources: Effect.succeed(true),
      };
      const evidence = await Effect.runPromise(resolveTeardownEvidence(AbsolutePath.make(alias), [a, b]));
      expect(evidence).toEqual({ kind: "applied", plan: planned, ownership: [hints] });
      expect(ownershipRoots).toEqual([canonical]);
      const offline = await Effect.runPromiseExit(
        resolveTeardownEvidence(AbsolutePath.make(alias), [a, { ...b, isAvailable: Effect.succeed(false) }]),
      );
      expect(Exit.isFailure(offline)).toBe(true);
      const service = {
        app: planned.id,
        appRoot: canonical,
        service: ServiceName.make("appserver"),
        providerId: planned.provider,
        status: "running" as const,
        publications: { status: "unknown" as const },
      };
      const orphaned = await Effect.runPromise(
        resolveTeardownEvidence(AbsolutePath.make(alias), [
          provider("lando", { list: () => Effect.succeed([service]) }),
        ]),
      );
      expect(orphaned).toMatchObject({ kind: "orphans", groups: [{ services: [service] }] });
    } finally {
      await rm(alias, { recursive: true, force: true });
      await rm(realRoot, { recursive: true, force: true });
    }
  });

  test("resolves applied state when the lookup root is a symlink alias of identity.appRoot", async () => {
    const realRoot = await mkdtemp(join(tmpdir(), "lando-applied-alias-"));
    const alias = join(dirname(realRoot), `alias-${basename(realRoot)}`);
    try {
      await symlink(realRoot, alias, "dir");
      const canonical = AbsolutePath.make(await realpath(realRoot));
      const planned = {
        ...planFor("lando"),
        root: canonical,
        identity: { appRoot: canonical, ownerKey: appIdentityKey("owner", canonical) },
      };
      const result = await Effect.runPromise(
        resolveAppliedPlanEvidence(AbsolutePath.make(alias), [
          provider("lando", { appliedPlans: Effect.succeed([planned]) }),
        ]),
      );
      expect(result).toEqual(planned);
    } finally {
      await rm(alias, { recursive: true, force: true });
      await rm(realRoot, { recursive: true, force: true });
    }
  });

  test("never adopts an ancestor app root's applied plan for a nested root", async () => {
    const nested = AbsolutePath.make(`${root}/sub`);
    const result = await Effect.runPromise(
      resolveTeardownEvidence(nested, [
        provider("lando", { appliedPlans: Effect.succeed([planFor("lando")]) }),
      ]),
    );

    expect(result).toEqual({ kind: "absent" });
  });

  test("keeps failing closed when applied state is attributed to the wrong supplier", async () => {
    const result = await Effect.runPromiseExit(
      resolveTeardownEvidence(root, [
        provider("lando", { appliedPlans: Effect.succeed([planFor("docker")]) }),
      ]),
    );

    expect(result._tag).toBe("Failure");
    expect(failureDetail(result)).toBe("applied-state-provider");
  });

  test("does not infer absence when no provider can supply evidence", async () => {
    const result = await Effect.runPromiseExit(resolveTeardownEvidence(root, []));

    expect(result._tag).toBe("Failure");
    expect(failureDetail(result)).toBe("provider-evidence");
  });
});

describe("exact applied-plan lookup", () => {
  test("returns the plan recorded for exactly this app root", async () => {
    const plan = planFor("lando");
    const resolved = await Effect.runPromise(
      resolveAppliedPlanEvidence(
        root,
        [provider("lando", { appliedPlans: Effect.succeed([plan]) })],
        undefined,
        "exact",
      ),
    );

    expect(resolved).toEqual(plan);
  });

  test("never adopts an enclosing app's plan for a nested app root", async () => {
    const nested = AbsolutePath.make(`${root}/sub`);
    const parent = planFor("lando");
    const providers = [provider("lando", { appliedPlans: Effect.succeed([parent]) })];

    // The default lookup resolves a working directory inside the parent app.
    expect(await Effect.runPromise(resolveAppliedPlanEvidence(nested, providers))).toEqual(parent);
    // The exact lookup answers only for the app recorded at that root.
    expect(
      await Effect.runPromise(resolveAppliedPlanEvidence(nested, providers, undefined, "exact")),
    ).toBeUndefined();
  });

  test("prefers the nested app's own record over an enclosing app's", async () => {
    const nestedRoot = `${root}/sub`;
    const nested = {
      ...planFor("lando"),
      root: AbsolutePath.make(nestedRoot),
      identity: { appRoot: AbsolutePath.make(nestedRoot), ownerKey: "nested-owner" },
    };
    const resolved = await Effect.runPromise(
      resolveAppliedPlanEvidence(
        nested.root,
        [provider("lando", { appliedPlans: Effect.succeed([planFor("lando"), nested]) })],
        undefined,
        "exact",
      ),
    );

    expect(resolved).toEqual(nested);
  });
});

test("verified adoption receipts retain exact unlabeled orphans for cleanup", async () => {
  const dataRoot = AbsolutePath.make("/tmp/applied-state-local-data");
  const foreign = AbsolutePath.make("/tmp/applied-state-foreign-data");
  const ownershipLabels = {
    "dev.lando.app": "failed-b",
    "dev.lando.app-root": root,
    "dev.lando.service": "web",
    "dev.lando.provider": "docker",
  };
  const unlabeled = {
    app: AppId.make("failed-b"),
    appRoot: root,
    service: ServiceName.make("web"),
    providerId: ProviderId.make("docker"),
    status: "running" as const,
    publications: { status: "unknown" as const },
    containerId: "inventory-only-web",
    nativeName: "legacy-web",
    labels: ownershipLabels,
  };
  const foreignLabeled = {
    ...unlabeled,
    containerId: "foreign-web",
    labels: { ...ownershipLabels, [LANDO_DATA_ROOT_LABEL]: foreign },
  };
  const ownership = {
    ...provider("docker", {
      isAvailable: Effect.succeed(true),
      list: () => Effect.succeed([unlabeled, foreignLabeled]),
    }),
    resourceOwnership: () =>
      Effect.succeed({
        appRoot: root,
        ownerKey: appIdentityKey("owner", root),
        providerId: ProviderId.make("docker"),
        appIds: [AppId.make("failed-b")],
        members: [
          {
            kind: "container" as const,
            nativeName: "legacy-web",
            nativeId: "inventory-only-web",
            dataRoot,
            appId: AppId.make("failed-b"),
            service: ServiceName.make("web"),
          },
        ],
      }),
    canCleanupOwnedResources: Effect.succeed(true),
  };
  const evidence = await Effect.runPromise(resolveTeardownEvidence(root, [ownership], undefined, dataRoot));
  expect(evidence.kind).toBe("orphans");
  if (evidence.kind !== "orphans") throw new Error("expected orphans");
  expect(evidence.groups).toHaveLength(1);
  expect(String(evidence.groups[0]?.providerId)).toBe("docker");
  expect(String(evidence.groups[0]?.appId)).toBe("failed-b");
  expect(evidence.groups[0]?.services.map((service) => service.containerId)).toEqual(["inventory-only-web"]);
});

test("historical applied plans without a data root remain selectable", async () => {
  const dataRoot = AbsolutePath.make("/tmp/applied-state-local-data");
  const historical = planFor("lando");
  const foreign = {
    ...planFor("lando"),
    id: AppId.make("foreign-app"),
    name: "foreign-app",
    identity: { appRoot: root, ownerKey: "foreign-owner", dataRoot: AbsolutePath.make("/tmp/other-data") },
  };
  const resolved = await Effect.runPromise(
    resolveAppliedPlanEvidence(
      root,
      [provider("lando", { appliedPlans: Effect.succeed([historical, foreign]) })],
      undefined,
      "exact",
      dataRoot,
    ),
  );
  expect(resolved).toEqual(historical);
});

test("unlabeled orphans without inventory-only proof are out of scope for a data root", async () => {
  const dataRoot = AbsolutePath.make("/tmp/applied-state-local-data");
  const unlabeled = {
    app: AppId.make("ghost"),
    appRoot: root,
    service: ServiceName.make("web"),
    providerId: ProviderId.make("lando"),
    status: "running" as const,
    publications: { status: "unknown" as const },
    containerId: "ghost-web",
  };
  const evidence = await Effect.runPromise(
    resolveTeardownEvidence(
      root,
      [provider("lando", { list: () => Effect.succeed([unlabeled]) })],
      undefined,
      dataRoot,
    ),
  );
  expect(evidence).toEqual({ kind: "absent" });
});

test("ownership without members does not claim unlabeled orphans for a data root", async () => {
  const dataRoot = AbsolutePath.make("/tmp/applied-state-local-data");
  const unlabeled = {
    app: AppId.make("failed-b"),
    appRoot: root,
    service: ServiceName.make("web"),
    providerId: ProviderId.make("docker"),
    status: "running" as const,
    publications: { status: "unknown" as const },
    containerId: "broad-web",
    labels: {
      "dev.lando.app": "failed-b",
      "dev.lando.app-root": root,
      "dev.lando.service": "web",
      "dev.lando.provider": "docker",
    },
  };
  const ownership = {
    ...provider("docker", {
      isAvailable: Effect.succeed(true),
      list: () => Effect.succeed([unlabeled]),
    }),
    resourceOwnership: () =>
      Effect.succeed({
        appRoot: root,
        ownerKey: appIdentityKey("owner", root),
        providerId: ProviderId.make("docker"),
        appIds: [AppId.make("failed-b")],
      }),
    canCleanupOwnedResources: Effect.succeed(true),
  };
  const evidence = await Effect.runPromise(resolveTeardownEvidence(root, [ownership], undefined, dataRoot));
  // Inventory without member rows is "owned" cleanup state, not historical unlabeled runtime proof.
  expect(evidence.kind).toBe("owned");
});
