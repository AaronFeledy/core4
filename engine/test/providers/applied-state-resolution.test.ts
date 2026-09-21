import { describe, expect, test } from "bun:test";

import { DateTime, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import {
  resolveAppliedPlanEvidence,
  resolveTeardownEvidence,
} from "../../src/providers/applied-state-resolution.ts";

const root = AbsolutePath.make("/tmp/applied-state-evidence");

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
    resolvedAt: DateTime.unsafeMake("2026-09-16T00:00:00.000Z"),
    source: "applied-state-resolution.test",
    runtime: 4,
  },
  extensions: {},
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
