import { join } from "node:path";
import type { StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import type { LockEntry } from "./include-context.ts";
import { parseLockEntries, writeLockEntries } from "./include-lockfile.ts";

export const createIncludeResolutionSession = Effect.fnUntraced(function* (input: {
  readonly appRoot: string;
  readonly lockfilePath?: string;
  readonly stateStore?: StateStoreShape;
  readonly readOnly?: boolean;
}) {
  const lockfilePath = input.lockfilePath ?? join(input.appRoot, ".lando.lock.yml");
  const existingPins = yield* Effect.cached(parseLockEntries(input.stateStore, input.appRoot, lockfilePath));
  return {
    appRoot: input.appRoot,
    lockfilePath,
    readOnly: input.readOnly === true,
    existingPins,
    selectors: new Map<string, string | undefined>(),
    selectedPins: new Map<string, LockEntry>(),
  };
});

export type IncludeResolutionSession = Effect.Success<ReturnType<typeof createIncludeResolutionSession>>;

export const publishIncludeProposals = (
  session: IncludeResolutionSession,
  stateStore: StateStoreShape | undefined,
) =>
  session.readOnly || session.selectedPins.size === 0
    ? Effect.void
    : writeLockEntries(stateStore, {
        appRoot: session.appRoot,
        lockfilePath: session.lockfilePath,
        entries: [...session.selectedPins.values()],
        merge: true,
      });
