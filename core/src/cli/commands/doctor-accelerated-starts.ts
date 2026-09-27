import { acceleratedStartInventory } from "@lando/engine/operations/accelerated-start-inventory";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { FileSystem, StateStore } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Effect, Layer, Option } from "effect";
import type { DoctorSubsystemCheck } from "./doctor-subsystem-checks";

export const acceleratedStartsDoctor = (redact: (text: string) => string) =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(StateStore);
    const fs = yield* Effect.serviceOption(FileSystem);
    const records = yield* acceleratedStartInventory.pipe(
      Effect.provide(
        Layer.merge(
          Option.isSome(store) ? Layer.succeed(StateStore, store.value) : StateStoreLive,
          Option.isSome(fs) ? Layer.succeed(FileSystem, fs.value) : FileSystemLive,
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
