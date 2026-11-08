import type { LandofileIncludeError, LandofileParseError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import type { LockEntry } from "./include-context.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";

export const loadIncludePins = Effect.fnUntraced(function* (input: {
  readonly pins: Effect.Effect<ReadonlyMap<string, LockEntry>, LandofileParseError | LandofileIncludeError>;
  readonly lockfile: string;
  readonly recorder: LoadFailureRecorder | undefined;
}) {
  const result = yield* Effect.result(input.pins);
  if (Result.isSuccess(result)) return { entries: result.success, available: true };
  if (input.recorder === undefined) return yield* Effect.fail(result.failure);
  if (!input.recorder.prerequisites.has(input.lockfile)) {
    input.recorder.record(result.failure);
    input.recorder.prerequisites.add(input.lockfile);
  }
  return { entries: new Map<string, LockEntry>(), available: false };
});
