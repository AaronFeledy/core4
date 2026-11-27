import { expect, test } from "bun:test";
import { type ConfigError, ProviderUnavailableError, appliedStateVersionError } from "@lando/sdk/errors";
import { AppId, FileSyncSessionRef, ProviderId } from "@lando/sdk/schema";
import { Cause, Effect, Exit } from "effect";
import { verifyPendingStartResume } from "../../src/operations/accelerated-start-resume.ts";
import { type StartAppError, startApp } from "../../src/operations/start.ts";
import { type StopAppError, stopApp } from "../../src/operations/stop.ts";
import { acceleratedPlan, app, recoveryHarness, target } from "./accelerated-start-recovery-support.ts";

test.each(
  (["start", "stop"] as const).flatMap((operation) =>
    (["changed-spec", "duplicate-identity", "duplicate-ref"] as const).map((inventory) => ({
      operation,
      inventory,
    })),
  ),
)(
  "pending %j rejects untrusted session inventory before hooks or mutation",
  async ({ operation, inventory }) => {
    // Given an unfinished attempt whose observed inventory cannot prove unique planned sessions.
    const harness = await Effect.runPromise(recoveryHarness({ phase: "preparing" }));
    const existing = harness.sessions[0];
    if (existing === undefined) throw new Error("Missing session fixture");
    switch (inventory) {
      case "changed-spec":
        harness.sessions.splice(0, 1, { ...existing, spec: { ...existing.spec, excludes: ["foreign"] } });
        break;
      case "duplicate-identity":
        harness.sessions.push({ ...existing, ref: FileSyncSessionRef.make("duplicate") });
        break;
      case "duplicate-ref":
        harness.sessions.push({ ...existing });
        break;
    }
    // When the lifecycle operation preflights the pending attempt.
    const result: Exit.Exit<void, StartAppError | StopAppError | ConfigError> =
      operation === "start"
        ? await Effect.runPromiseExit(startApp({}, target).pipe(Effect.asVoid, Effect.provide(harness.layer)))
        : await Effect.runPromiseExit(stopApp({}, target).pipe(Effect.asVoid, Effect.provide(harness.layer)));
    // Then it fails closed without init, preparation, or session mutations.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.findErrorOption(result.cause)).toMatchObject({
        value: { _tag: operation === "start" ? "FileSyncStartError" : "FileSyncStopError" },
      });
    expect(harness.calls).toEqual([]);
    expect(harness.events).toEqual([]);
  },
);

test.each(["provider", "app", "corrupt"] as const)(
  "pending resume rejects %s ownership before init or mutation",
  async (kind) => {
    // Given a pending attempt with untrusted provider ownership evidence.
    const harness = await Effect.runPromise(
      recoveryHarness({
        phase: "preparing",
        harnessOptions: {
          resourceOwnership: () =>
            kind === "corrupt"
              ? Effect.fail(
                  new ProviderUnavailableError({
                    providerId: "lando",
                    operation: "ownership",
                    message: "corrupt manifest",
                    remediation:
                      "Install or start the `lando` provider and confirm it can perform `ownership`.",
                  }),
                )
              : Effect.succeed({
                  appRoot: app.root,
                  ownerKey: "owner",
                  providerId: ProviderId.make(kind === "provider" ? "foreign" : "lando"),
                  appIds: [kind === "app" ? AppId.make("foreign") : app.id],
                }),
        },
      }),
    );
    // When start attempts to resume.
    const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
    // Then ownership failure is tagged and leaves hooks, sessions and targets untouched.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.findErrorOption(result.cause)).toMatchObject({ value: { _tag: "FileSyncStartError" } });
    expect(harness.calls).toEqual([]);
    expect(harness.events).toEqual([]);
  },
);

test("pending resume refuses protected applied state before preparing targets", async () => {
  // Given a pending attempt whose provider reports newer applied state as an unknown file-sync verdict.
  const newer = appliedStateVersionError({
    path: "/state/applied.json",
    storedVersion: 99,
    supportedVersion: 1,
    appId: app.id,
    providerId: "lando",
    operation: "applied-state.read",
    scope: "app",
  });
  const harness = await Effect.runPromise(
    recoveryHarness({
      phase: "preparing",
      appliedState: "unknown",
      harnessOptions: { readAppliedPlanStrict: () => Effect.fail(newer) },
    }),
  );
  // When any entry reaches the shared resume boundary.
  const result = await Effect.runPromiseExit(
    verifyPendingStartResume(app, acceleratedPlan).pipe(Effect.provide(harness.layer)),
  );
  // Then the version error keeps its remediation and no target is prepared.
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(Cause.findErrorOption(result.cause)).toMatchObject({
      value: { _tag: "AppliedStateVersionError", remediation: newer.remediation },
    });
  expect(harness.calls).toEqual([]);
});
