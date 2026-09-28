import { createHash } from "node:crypto";
import { FileSyncStartError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";

export const PendingStart = Schema.Struct({
  attemptId: Schema.String,
  recoveredFrom: Schema.optional(Schema.String),
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  engineId: Schema.String,
  mountPlanDigest: Schema.String,
  phase: Schema.Literal("preparing", "sessions-ready", "apply-intent", "retained", "completed"),
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
export const isRecoverableStart = (record: PendingStart | null): record is PendingStart =>
  record !== null &&
  record.phase !== "completed" &&
  (record.phase === "retained" || record.recoveredFrom !== undefined);
export const pendingStartBucketSpec = (key: string) =>
  ({
    root: "userData",
    namespace: "accelerated-starts",
    key,
    schema: PendingStart,
    version: 1,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
    onVersionMismatch: () => {
      throw new FileSyncStartError({
        engineId: "unknown",
        message: "Unknown accelerated-start journal version.",
        remediation:
          "Use the Lando version that wrote this journal; do not delete unverified recovery records.",
      });
    },
  }) as const;
export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const journalRecovery = (path: string) =>
  `Run \`lando start\` in the app root to recover a retained attempt or interrupted recovery, or \`lando destroy\` to discard it (add --volumes only to remove volumes). Inspect \`lando doctor\` and journal \`${path}\` if recovery is blocked. Pending first attempts without a recovery marker require inspection before retrying.`;

export const verifyRetainedStart = (previous: PendingStart, planned: PendingStart, path: string) => {
  const mismatch =
    previous.providerId !== planned.providerId
      ? "provider changed"
      : previous.engineId !== planned.engineId
        ? "engine changed"
        : previous.mountPlanDigest !== planned.mountPlanDigest
          ? "mount plan digest changed"
          : previous.appId !== planned.appId ||
              previous.appRoot !== planned.appRoot ||
              digest(previous.targets) !== digest(planned.targets) ||
              digest(previous.sessions) !== digest(planned.sessions)
            ? "recorded target or session identities differ from the plan"
            : undefined;
  return mismatch === undefined
    ? Effect.void
    : Effect.fail(
        new FileSyncStartError({
          engineId: previous.engineId,
          message: `Automatic recovery is not possible: ${mismatch}.`,
          remediation: journalRecovery(path),
        }),
      );
};
