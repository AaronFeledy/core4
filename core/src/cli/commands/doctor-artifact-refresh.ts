import { type PullChecks, openPullChecks, overduePullChecks } from "@lando/engine/services/artifact-refresh";
import { StateStore } from "@lando/sdk/services";
import { Effect } from "effect";

import type { DoctorFinding } from "./doctor-contract";

const DAY_MS = 24 * 60 * 60 * 1000;

const ageDays = (checkedAt: number, now: number): number =>
  Math.max(0, Math.floor((now - checkedAt) / DAY_MS));

export const buildArtifactRefreshDoctorCheck = (input: {
  readonly checks: PullChecks;
  readonly now: number;
  readonly runtimeId: string;
}): DoctorFinding | undefined => {
  const tracked = Object.values(input.checks).filter((check) => check.runtimeId === input.runtimeId);
  if (tracked.length === 0) return undefined;
  const overdue = overduePullChecks(input.checks, { runtimeId: input.runtimeId, now: input.now });
  const status = overdue.length === 0 ? "pass" : "warn";
  const oldest = overdue[0];
  return {
    name: "artifact-refresh",
    status,
    severity: status === "pass" ? "info" : "warn",
    context: {
      tracked: String(tracked.length),
      overdue: String(overdue.length),
      ...(oldest === undefined
        ? {}
        : { oldestRef: oldest.ref, oldestAgeDays: String(ageDays(oldest.checkedAt, input.now)) }),
    },
    solutions:
      oldest === undefined
        ? []
        : [
            {
              kind: "manual" as const,
              description: "The next start checks the registry. Run lando rebuild to check now.",
              command: "lando rebuild",
            },
          ],
  };
};

export const collectArtifactRefreshDoctorCheck = Effect.fnUntraced(function* (input: {
  readonly runtimeId: string;
  readonly now: number;
}) {
  const store = yield* Effect.serviceOption(StateStore);
  if (store._tag === "None") return undefined;
  const checks = yield* openPullChecks(store.value).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.catch(() => Effect.succeed(null)),
  );
  if (checks === null) return undefined;
  return buildArtifactRefreshDoctorCheck({ ...input, checks });
});
