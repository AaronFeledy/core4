import { describe, expect, test } from "bun:test";

import { DateTime, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ListFilter, RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import {
  observeProviderRuntime,
  resolveAppliedPlanEvidence,
  resolveTeardownEvidence,
} from "../../src/providers/applied-state-resolution.ts";

const root = AbsolutePath.make("/tmp/applied-state-evidence");

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
  networks: [],
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
    expect(String(result)).toContain("applied-state-provider");
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
    expect(String(result)).toContain("provider-evidence");
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
    expect(String(result)).toContain("applied-state-provider");
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
              },
            ]),
        }),
      ]),
    );

    expect(result._tag).toBe("Failure");
    expect(String(result)).toContain("provider-resources");
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
    expect(String(result)).toContain("provider-resources");
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
              },
            ]),
        }),
      ]),
    );

    expect(result).toEqual({ kind: "absent" });
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
    expect(String(result)).toContain("applied-state-provider");
  });

  test("does not infer absence when no provider can supply evidence", async () => {
    const result = await Effect.runPromiseExit(resolveTeardownEvidence(root, []));

    expect(result._tag).toBe("Failure");
    expect(String(result)).toContain("provider-evidence");
  });
});
