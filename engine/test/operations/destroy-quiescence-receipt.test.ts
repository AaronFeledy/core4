import { expect, test } from "bun:test";
import {
  AppId,
  FileSyncSessionRef,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServiceShutdownObservation,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { mergeShutdownObservations } from "../../src/operations/shutdown-observations.ts";
import { makeHarness, plan } from "./destroy-progress-topology-support.ts";

const identity = { appId: plan.id, providerId: ProviderId.make("lando"), service: ServiceName.make("web") };
const observations: readonly ServiceShutdownObservation[] = [
  { ...identity, containerId: "windows-web-exact", status: "exited", exitCode: 137, oomKilled: true },
  {
    ...identity,
    service: ServiceName.make("worker"),
    containerId: "windows-worker-exact",
    status: "unknown",
    reason: "inspect-failed",
    diagnostic: {
      _tag: "ProviderOperationError",
      message: "inspect failed: [REDACTED]",
      remediation: "Check the existing runtime connection.",
    },
  },
];

test.each(["accelerated", "ordinary", "no-observations"] as const)(
  "destroy retains quiescence facts when the later Windows runtime teardown is absent (%s)",
  async (mode) => {
    // Given a Windows-style volume sync session and a provider that removes writers during quiescence.
    const calls: string[] = [];
    let removed = false;
    const app = { kind: "user" as const, id: plan.id, root: plan.root };
    const spec = {
      app,
      service: identity.service,
      mountKey: "app-mount",
      source: plan.root,
      target: { _tag: "volume" as const, name: "windows-sync-volume", path: PortablePath.make("/app") },
      mode: "two-way-safe" as const,
      excludes: [],
    };
    const session = {
      ref: FileSyncSessionRef.make("windows-sync"),
      app,
      service: spec.service,
      mountKey: spec.mountKey,
      spec,
      status: "running" as const,
      lastUpdatedAt: DateTime.makeUnsafe("2026-09-23T00:00:00Z"),
    };
    const harness = makeHarness({
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([session]),
        flushSession: () =>
          Effect.sync(() => {
            calls.push("flush");
          }),
        terminateSession: () =>
          Effect.sync(() => {
            calls.push("dispose");
          }),
      },
    });
    const provider = {
      ...TestRuntimeProvider,
      id: "lando" as const,
      platform: "win32" as const,
      list: () => Effect.succeed([]),
      inspectAppliedFileSync: () =>
        Effect.succeed(
          mode === "ordinary"
            ? { status: "ordinary" as const }
            : { status: "accelerated" as const, engineId: "mutagen", sessions: [spec] },
        ),
      quiesceForFileSync: () =>
        Effect.sync(() => {
          calls.push("quiesce");
          removed = true;
          return mode === "no-observations" ? {} : { shutdownObservations: observations };
        }),
      disposeFileSyncTargets: () =>
        Effect.sync(() => {
          calls.push("targets");
        }),
      destroy: () =>
        Effect.sync(() => {
          calls.push("destroy");
          return {
            kind: "destroyed" as const,
            ...(mode === "no-observations"
              ? {}
              : {
                  shutdownObservations: removed
                    ? observations.map(({ appId, providerId, service }) => ({
                        appId,
                        providerId,
                        service,
                        status: "unknown" as const,
                        reason: "container-absent" as const,
                      }))
                    : observations,
                }),
          };
        }),
    };
    // When the public destroy operation quiesces, flushes, disposes, then finishes provider cleanup.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        return yield* destroyAppForTarget({}, { plan, root: plan.root, app }).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...registry,
            select: () => Effect.succeed(provider),
            resolveAppliedPlan: () => Effect.succeed(plan),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "applied" as const, plan }),
          }),
        );
      }).pipe(Effect.provide(harness.layer)),
    );
    // Then terminal facts and sanitized diagnostics survive without later absence placeholders.
    expect(calls).toEqual(
      mode === "ordinary" ? ["destroy"] : ["quiesce", "flush", "dispose", "targets", "destroy"],
    );
    if (mode === "no-observations") expect(result).not.toHaveProperty("shutdownObservations");
    else expect(result.shutdownObservations).toEqual(observations);
  },
);

test("absence coalescence preserves distinct exact containers, apps and providers", () => {
  // Given earlier facts and later absence observations with both matching and distinct identities.
  const absent = { ...identity, status: "unknown" as const, reason: "container-absent" as const };
  const distinct = [
    { ...absent, containerId: "replacement" },
    { ...absent, appId: AppId.make("other-app") },
    { ...absent, providerId: ProviderId.make("docker") },
  ];
  // When observations are merged in action order.
  const result = mergeShutdownObservations(observations, [
    absent,
    { ...absent, containerId: "windows-web-exact" },
  ]);
  const separate = mergeShutdownObservations(observations, distinct);
  // Then only redundant absence placeholders are omitted; distinct exact identities remain.
  expect(result).toEqual(observations);
  expect(separate).toEqual([...observations, ...distinct]);
});
