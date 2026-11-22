import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError, appliedStateVersionError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type PlanMetadata,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";

import { infoForPlan } from "../../src/operations/info.ts";

const root = AbsolutePath.make("/tmp/info-applied-state");
const providerId = ProviderId.make("docker");
const metadata: PlanMetadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
  source: "info-applied-state.test",
  runtime: 4,
};

const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "web",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:alpine" },
  command: ["nginx"],
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const demoPlan = (): AppPlan => ({
  id: AppId.make("demo"),
  name: "demo",
  slug: "demo",
  root,
  identity: { appRoot: root, ownerKey: "demo-owner" },
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const runInfo = async (registry: ReturnType<typeof RuntimeProviderRegistry.of>) =>
  Effect.runPromise(infoForPlan(demoPlan()).pipe(Effect.provideService(RuntimeProviderRegistry, registry)));

const baseRegistry = (
  overrides: Partial<ReturnType<typeof RuntimeProviderRegistry.of>> = {},
  inspect?: RuntimeProviderShape["inspect"],
) => {
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: providerId,
    inspect:
      inspect ??
      ((target) =>
        Effect.succeed({
          app: AppId.make("demo"),
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          publications: { status: "unknown" as const },
        })),
  };
  return RuntimeProviderRegistry.of({
    readAppliedPlanStrict: () => Effect.succeed(undefined),
    appliedStateInventory: () => Effect.die("Info must not scan inventory to diagnose a targeted read"),
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
    ...overrides,
  });
};

describe("info applied-state observation", () => {
  test("omits the issue when the targeted strict read finds no record", async () => {
    const result = await runInfo(baseRegistry());
    expect(result).not.toHaveProperty("appliedStateIssue");
    expect(result.fileSync).not.toHaveProperty("applied");
  });

  test("omits the issue when the targeted strict read returns the applied plan", async () => {
    const applied = demoPlan();
    const result = await runInfo(baseRegistry({ readAppliedPlanStrict: () => Effect.succeed(applied) }));
    expect(result).not.toHaveProperty("appliedStateIssue");
  });

  test("reports a newer receipt even when service inspection fails on that receipt", async () => {
    const error = appliedStateVersionError({
      providerId,
      operation: "applied-state.read",
      path: "/tmp/info-applied-state/applied.json",
      storedVersion: 11,
      supportedVersion: 10,
      scope: "app",
      appId: "demo",
    });
    const result = await runInfo(
      baseRegistry({ readAppliedPlanStrict: () => Effect.fail(error) }, () => Effect.fail(error)),
    );
    expect(result.appliedStateIssue).toMatchObject({
      reason: "newer-version",
      path: "/tmp/info-applied-state/applied.json",
      storedVersion: 11,
      supportedVersion: 10,
      remediation: error.remediation,
    });
    expect(result.fileSync?.applied).toMatchObject({ mode: "unknown" });
    expect(result.fileSync?.pendingChange).toBe(false);
    expect(result.services[0]?.status).toBe("unknown");
  });

  test("reports the damaged record path and remediation from the strict read failure", async () => {
    const result = await runInfo(
      baseRegistry({
        readAppliedPlanStrict: () =>
          Effect.fail(
            new ProviderUnavailableError({
              providerId,
              operation: "applied-state.read",
              details: { path: "/tmp/info-applied-state/applied.json", coordinate: "plan" },
              message:
                'The applied provider state file "/tmp/info-applied-state/applied.json" is unreadable.',
              remediation:
                "Restore a readable applied-state record from a trusted backup or remove the corrupt file.",
            }),
          ),
      }),
    );
    expect(result.appliedStateIssue).toEqual({
      reason: "unreadable",
      path: "/tmp/info-applied-state/applied.json",
      message: 'The applied provider state file "/tmp/info-applied-state/applied.json" is unreadable.',
      remediation:
        "Restore a readable applied-state record from a trusted backup or remove the corrupt file.",
    });
    expect(result.fileSync?.applied).toMatchObject({ mode: "unknown" });
  });

  test("propagates non-applied-state registry failures", async () => {
    await expect(
      runInfo(
        baseRegistry({
          readAppliedPlanStrict: () =>
            Effect.fail(
              new ProviderUnavailableError({
                providerId,
                operation: "select",
                message: "provider offline",
                remediation: "Start the provider.",
              }),
            ),
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
