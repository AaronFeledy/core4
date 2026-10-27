import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { Cause, DateTime, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { ListFilter, RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

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

const root = AbsolutePath.make("/tmp/applied-state-evidence");

test("per-app inventory damage does not poison readable plans or an unrelated cwd", async () => {
  const plan = planFor("docker");
  const damaged = {
    ...provider("docker", { appliedPlans: Effect.succeed([plan]) }),
    appliedStateInventory: Effect.succeed({
      plans: [plan],
      unreadable: [{ appId: AppId.make("damaged-a"), path: "/tmp/isolated-state/damaged-a.json" }],
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
      unreadable: [{ path: "/tmp/isolated-podman/applied-plans.json" }],
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
          { path: "/tmp/isolated-state/applied.json", ...(layout === "per-app" ? { appId } : {}) },
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
    const evidence = await Effect.runPromise(resolveTeardownEvidence(root, [damaged]));
    expect(evidence).toEqual({
      kind: "owned",
      ownership: [
        {
          appRoot: root,
          ownerKey: appIdentityKey("owner", root),
          providerId: ProviderId.make("docker"),
          appIds: [appId],
        },
      ],
    });
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
  "read-only discovery treats %s protected state as unknown, not orphaned",
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
          { path: "/tmp/isolated-state/applied.json", ...(layout === "per-app" ? { appId } : {}) },
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
    expect(await Effect.runPromise(resolveAppliedPlanEvidence(root, [damaged]))).toBeUndefined();
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

test("inventory-only evidence refuses non-teardown resolution", async () => {
  // Given
  const b = {
    ...provider("docker", { isAvailable: Effect.succeed(true) }),
    resourceOwnership: () =>
      Effect.succeed({
        appRoot: root,
        ownerKey: appIdentityKey("owner", root),
        providerId: ProviderId.make("docker"),
        appIds: [AppId.make("failed-b")],
      }),
    canCleanupOwnedResources: Effect.succeed(true),
  };
  // When
  const exit = await Effect.runPromiseExit(resolveAppliedPlanEvidence(root, [b]));
  // Then
  expect(failureDetail(exit)).toBe("provider-resources");
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
    filter: {},
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
        status: "running",
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
                status: "running",
                publications: { status: "unknown" as const },
              },
            ]),
        }),
      ]),
    );

    expect(result._tag).toBe("Failure");
    expect(failureDetail(result)).toBe("provider-resources");
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
                status: "running",
                publications: { status: "unknown" as const },
              },
            ]),
        }),
      ]),
    );

    expect(result).toBeUndefined();
  });

  test("does not report absence while an owned volume remains", async () => {
    const result = await Effect.runPromiseExit(
      resolveAppliedPlanEvidence(root, [
        provider("lando", {
          listVolumes: () =>
            Effect.succeed([
              {
                ref: { app: AppId.make("orphaned-app"), store: "database" },
                identity: {
                  coordinationKey: "lando:orphaned-app:database",
                  nativeName: "orphaned-app_database",
                  generation: "generation-1",
                  ownerRoot: root,
                  origin: "created",
                },
              },
            ]),
        }),
      ]),
    );

    expect(result._tag).toBe("Failure");
    expect(failureDetail(result)).toBe("provider-resources");
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
      status: "running",
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
                status: "running",
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
        status: "running",
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
