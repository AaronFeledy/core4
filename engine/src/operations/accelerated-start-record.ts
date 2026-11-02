import { sha256Hex } from "@lando/sdk/digest";
import { FileSyncStartError } from "@lando/sdk/errors";
import type { PreparedFileSyncTarget } from "@lando/sdk/schema";
import { Schema } from "effect";

export const PendingStart = Schema.Struct({
  attemptId: Schema.String,
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  engineId: Schema.String,
  mountPlanDigest: Schema.String,
  phase: Schema.Literals(["preparing", "sessions-ready", "apply-intent", "completed"]),
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
export const pendingStartBucketSpec = (key: string) =>
  ({
    root: "userData",
    namespace: "accelerated-starts",
    key,
    schema: PendingStart,
    version: 2,
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
