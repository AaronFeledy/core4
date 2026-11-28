import { annotateFailureContext } from "@lando/sdk/command-result";
import type { EventError, ServiceDataVersionError, ServiceRestorePointError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import type { AppPlan, ServiceName, SnapshotId } from "@lando/sdk/schema";
import { DataMover, EventService, StateStore } from "@lando/sdk/services";
import { makeTaskTree, runWithTaskTree } from "@lando/sdk/task-progress";
import { DateTime, Effect, Exit, Option } from "effect";
import { mergeFailure, runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { registerBuildRedaction } from "../services/build-redaction.ts";
import { withPrefetchedSourceArtifacts } from "../services/source-artifact.ts";
import type { DataUpgrade } from "./data-version-admission.ts";
import { restoreCommand } from "./upgrade-restore-remediation.ts";
import { type UndoCapture, captureRestorePoint } from "./upgrade-volume-capture.ts";

export type PrepareUpgrade = Effect.Effect<
  void,
  EventError | ServiceDataVersionError | ServiceRestorePointError,
  EventService
>;

export const withUpgradeRestorePoints =
  (input: {
    readonly plan: AppPlan;
    readonly provider: PreparedRuntimeProvider;
    readonly upgrades: readonly DataUpgrade[];
    readonly stoppedChecks: readonly DataUpgrade[];
    readonly noSnapshot: boolean | undefined;
    readonly refresh: boolean;
  }) =>
  <A, E, R>(
    body: (preparation: {
      readonly prepareUpgrade: PrepareUpgrade;
      readonly points: ReadonlyMap<ServiceName, SnapshotId>;
      readonly verifiedFrom: ReadonlyMap<ServiceName, string>;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.fn("AppActivation.withUpgradeRestorePoints")(function* () {
      const points = new Map<ServiceName, SnapshotId>();
      const verifiedFrom = new Map<ServiceName, string>();
      const unverified = new Set<ServiceName>();
      const stoppedChecks =
        input.noSnapshot === true
          ? [...input.stoppedChecks, ...input.upgrades.filter(({ source }) => source === "applied-plan")]
          : input.stoppedChecks;
      for (const upgrade of stoppedChecks) {
        yield* captureRestorePoint({
          app: input.plan.name,
          plan: input.plan,
          provider: input.provider,
          upgrade,
        }).pipe(Effect.catchTag("ServiceRestorePointError", () => Effect.void));
      }
      if (input.noSnapshot === true || input.upgrades.length === 0)
        return yield* body({ prepareUpgrade: Effect.void, points, verifiedFrom });
      const mover = yield* Effect.serviceOption(DataMover);
      const events = yield* EventService;
      const notice = (body: string) =>
        DateTime.now.pipe(
          Effect.flatMap((timestamp) => events.publish(MessageInfoEvent.make({ body, timestamp }))),
        );
      const prepared: UndoCapture[] = [];
      const capture = Effect.gen(function* () {
        if (Option.isNone(mover)) {
          for (const { service } of input.upgrades)
            yield* notice(`No restore point was saved for ${service}: the data mover is unavailable.`);
          return;
        }
        yield* notice(
          "The database stays offline while Lando copies its data. Allow free disk space about the size of its volume.",
        );
        const tree = makeTaskTree(events, {
          parentId: `upgrade-restore-point:${input.plan.id}`,
          label: `Save database upgrade restore points for ${input.plan.name}`,
          children: input.upgrades.map(({ service }) => ({ id: service, label: `Save ${service}` })),
          prefixChildIds: true,
        });
        yield* runWithTaskTree(
          tree,
          (active) =>
            Effect.gen(function* () {
              for (const upgrade of input.upgrades) {
                const { service, label, to } = upgrade;
                yield* notice(`Saving a restore point of ${service} before moving to ${label} ${to}…`);
                yield* active.startTask(service);
                const captured = yield* captureRestorePoint({
                  app: input.plan.name,
                  plan: input.plan,
                  provider: input.provider,
                  upgrade,
                  publication: {
                    mover: mover.value,
                    onPrepare: (undo) => prepared.push(undo),
                    onCommit: (snapshot) => points.set(service, snapshot.id),
                  },
                });
                if (captured === undefined) continue;
                const { handle, verified } = captured;
                if (verified !== undefined) verifiedFrom.set(service, verified);
                if (verified === undefined && upgrade.source === "applied-plan") unverified.add(service);
                yield* notice(`Saved restore point ${handle.id} for ${service}.`);
                yield* active.completeTask(service);
              }
            }),
          {
            success: "Database restore points saved",
            failure: "Database restore point capture failed",
            interrupt: "Database restore point capture interrupted",
          },
        );
      });
      const prepareUpgrade = yield* Effect.cached(capture);
      const activation = Effect.suspend(() => body({ prepareUpgrade, points, verifiedFrom }));
      const settle = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(activation));
          if (Exit.isSuccess(exit)) return exit.value;
          const cleanup = yield* Effect.exit(
            runAllAndMergeFailures(
              prepared.toReversed().map((undo) =>
                Effect.gen(function* () {
                  const message = yield* undo;
                  if (message !== undefined) yield* notice(message).pipe(Effect.ignoreCause);
                }),
              ),
            ),
          );
          const cause = Exit.isFailure(cleanup)
            ? mergeFailure(exit.cause, cleanup.cause, "rollback")
            : exit.cause;
          return yield* Effect.failCause(
            points.size === 0
              ? cause
              : annotateFailureContext(cause, { restorePointIds: [...points.values()] }),
          );
        }),
      );
      const result =
        Option.isSome(mover) && input.provider.capabilities.artifactPull
          ? yield* withPrefetchedSourceArtifacts(
              {
                provider: input.provider,
                services: Object.values(input.plan.services).filter(({ name }) =>
                  input.upgrades.some(({ service }) => service === name),
                ),
                options: {
                  refresh: input.refresh,
                  events,
                  stateStore: yield* StateStore,
                  redactor: (yield* registerBuildRedaction(input.plan)).redactor,
                },
              },
              settle,
            )
          : yield* settle;
      for (const [service, id] of points) {
        yield* notice(
          unverified.has(service)
            ? `Restore point ${id} is available for ${service}, but its data series could not be verified. Check the series independently before using \`${restoreCommand(id, service)} --any-series\`.`
            : `Restore point ${id} is available for ${service}. To roll back, set the original database version, run \`${restoreCommand(id, service)}\`, then run \`lando start\`.`,
        );
      }
      return result;
    });
