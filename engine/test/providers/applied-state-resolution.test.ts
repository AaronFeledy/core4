import { describe, expect, test } from "bun:test";

import { DateTime, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { resolveAppliedPlanEvidence } from "../../src/providers/applied-state-resolution.ts";

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
