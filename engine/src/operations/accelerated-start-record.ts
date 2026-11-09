import { sha256Hex } from "@lando/sdk/digest";
import { FileSyncStartError } from "@lando/sdk/errors";
import type { PreparedFileSyncTarget } from "@lando/sdk/schema";
import { defineTransitions } from "@lando/sdk/transitions";
import { Schema } from "effect";

const PendingStartPhase = Schema.Literals(["preparing", "sessions-ready", "apply-intent", "completed"]);

/**
 * One attempt's steps. A resumed attempt replays its start steps, so a step whose
 * effect already holds is settled. Only `lando stop` and `lando destroy` abandon an
 * open attempt; `lando start` completes only after the provider applied the plan.
 */
export const pendingStartTransitions = defineTransitions<
  typeof PendingStartPhase.Type | "absent" | "foreign"
>()({
  "record-sessions": {
    from: ["preparing"],
    to: "sessions-ready",
    settledIn: ["sessions-ready", "apply-intent", "completed"],
  },
  "record-apply-intent": {
    from: ["sessions-ready"],
    to: "apply-intent",
    settledIn: ["apply-intent", "completed"],
  },
  complete: { from: ["apply-intent", "completed"], to: "absent", settledIn: ["absent"] },
  abandon: {
    from: ["preparing", "sessions-ready", "apply-intent", "completed"],
    to: "absent",
    settledIn: ["absent"],
  },
});

export type PendingStartStep = Exclude<keyof typeof pendingStartTransitions.edges, "abandon">;

export const PendingStart = Schema.Struct({
  attemptId: Schema.String,
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  engineId: Schema.String,
  mountPlanDigest: Schema.String,
  phase: PendingStartPhase,
  targets: Schema.Array(
    Schema.Struct({
      service: Schema.String,
      mountKey: Schema.String,
      volumeName: Schema.String,
      helperSpecDigest: Schema.String,
    }),
  ),
  sessions: Schema.Array(Schema.Struct({ name: Schema.String, specDigest: Schema.String })),
});
export type PendingStart = typeof PendingStart.Type;
const LegacyPendingStart = Schema.Struct({
  ...PendingStart.fields,
  phase: Schema.Literals(["preparing", "sessions-ready", "apply-intent", "retained", "completed"]),
  recoveredFrom: Schema.optionalKey(Schema.String),
});
export const PENDING_START_VERSION = 2;

export const pendingStartBucketSpec = (key: string) =>
  ({
    root: "userData",
    namespace: "accelerated-starts",
    key,
    schema: PendingStart,
    version: PENDING_START_VERSION,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
    onVersionMismatch: (raw: unknown, fromVersion: number): PendingStart => {
      if (fromVersion === 1) {
        const { recoveredFrom: _, ...record } = Schema.decodeUnknownSync(LegacyPendingStart)(raw);
        return { ...record, phase: record.phase === "retained" ? "apply-intent" : record.phase };
      }
      throw new FileSyncStartError({
        engineId: "unknown",
        message: "Unknown accelerated-start journal version.",
        remediation:
          "Use the Lando version that wrote this journal; do not delete unverified recovery records.",
      });
    },
  }) as const;
export const digest = (value: unknown): string => sha256Hex(JSON.stringify(value));
export const journalRecovery = (path: string) =>
  `Run \`lando start\` (or \`lando restart\` or \`lando rebuild\`) in the app root to finish the attempt. \`lando stop\` and \`lando destroy\` also work from any phase. Journal: \`${path}\`.`;

export const sameStartIdentity = (previous: PendingStart, planned: PendingStart) =>
  previous.providerId === planned.providerId &&
  previous.engineId === planned.engineId &&
  previous.mountPlanDigest === planned.mountPlanDigest &&
  previous.appId === planned.appId &&
  previous.appRoot === planned.appRoot &&
  digest(previous.targets) === digest(planned.targets) &&
  digest(previous.sessions) === digest(planned.sessions);

export const matchesRecordedTargets = (record: PendingStart, targets: readonly PreparedFileSyncTarget[]) =>
  targets.length === record.targets.length &&
  targets.every(({ session, endpoint }) =>
    record.targets.some(
      (target) =>
        target.service === session.service &&
        target.mountKey === session.mountKey &&
        target.volumeName === endpoint.volumeName,
    ),
  );
