import { acceleratedStartInventory } from "@lando/engine/operations/accelerated-start-inventory";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { FileSystem, StateStore } from "@lando/sdk/services";
import { Effect, Layer, Option } from "effect";
import type { DoctorSubsystemCheck } from "./doctor-subsystem-checks";

export const acceleratedStartsDoctor = Effect.fnUntraced(function* (redact: (text: string) => string) {
  const store = yield* Effect.serviceOption(StateStore);
  if (Option.isNone(store)) return [];
  const fs = yield* Effect.serviceOption(FileSystem);
  const records = yield* acceleratedStartInventory.pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(StateStore, store.value),
        Option.isSome(fs) ? Layer.succeed(FileSystem, fs.value) : BunFileSystem.layer,
      ),
    ),
  );
  return records.map(
    (record): DoctorSubsystemCheck => ({
      name: "accelerated-start",
      status: "fail",
      severity: "error",
      recovery: "manual",
      context: Object.fromEntries(
        Object.entries({
          appId: record.appId,
          appRoot: record.appRoot,
          phase: record.phase,
          attemptId: record.attemptId,
          ...(record.recoveredFrom === undefined
            ? {}
            : {
                recoveredFrom: record.recoveredFrom,
                recoveryState: "interrupted recovery",
              }),
          providerId: record.providerId,
          engineId: record.engineId,
          journalPath: record.path,
          sessions: record.sessions.map(({ name }) => name).join(", "),
          volumes: record.targets.map(({ volumeName }) => volumeName).join(", "),
        }).map(([key, value]) => [key, redact(value)]),
      ),
      solutions: [{ kind: "manual", description: redact(record.remediation) }],
    }),
  );
});
