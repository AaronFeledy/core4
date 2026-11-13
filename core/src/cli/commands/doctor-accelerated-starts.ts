import { acceleratedStartInventory } from "@lando/engine/operations/accelerated-start-inventory";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { FileSystem, StateStore } from "@lando/sdk/services";
import { Effect, Layer, Option } from "effect";
import type { DoctorFinding } from "./doctor-contract";

export const acceleratedStartsDoctor = Effect.fnUntraced(function* (redact: (text: string) => string) {
  const store = yield* Effect.serviceOption(StateStore);
  if (Option.isNone(store)) return [];
  const fs = yield* Effect.serviceOption(FileSystem);
  const inventory = yield* acceleratedStartInventory.pipe(
    Effect.flatMap((inventory) =>
      Effect.filter(inventory.records, (record) =>
        FileSystem.pipe(
          Effect.flatMap((fs) => fs.exists(record.appRoot)),
          Effect.catch(() => Effect.succeed(true)),
        ),
      ).pipe(Effect.map((records) => ({ ...inventory, records }))),
    ),
    Effect.provide(
      Layer.merge(
        Layer.succeed(StateStore, store.value),
        Option.isSome(fs) ? Layer.succeed(FileSystem, fs.value) : BunFileSystem.layer,
      ),
    ),
  );
  return [
    ...inventory.unreadable.map(
      (journal): DoctorFinding => ({
        name: "accelerated-start-journal",
        status: "warn",
        severity: "warn",
        recovery: "manual",
        context: {
          journalPath: redact(journal.path),
          errorTag: redact(journal._tag),
          error: redact(journal.message),
        },
        solutions: [{ kind: "manual", description: redact(journal.remediation) }],
      }),
    ),
    ...inventory.records.map(
      (record): DoctorFinding => ({
        name: "accelerated-start",
        status: "warn",
        severity: "warn",
        recovery: "manual",
        context: Object.fromEntries(
          Object.entries({
            appId: record.appId,
            appRoot: record.appRoot,
            phase: record.phase,
            attemptId: record.attemptId,
            providerId: record.providerId,
            engineId: record.engineId,
            journalPath: record.path,
            sessions: record.sessions.map(({ name }) => name).join(", "),
            volumes: record.targets.map(({ volumeName }) => volumeName).join(", "),
          }).map(([key, value]) => [key, redact(value)]),
        ),
        solutions: [{ kind: "manual", description: redact(record.remediation) }],
      }),
    ),
  ];
});
