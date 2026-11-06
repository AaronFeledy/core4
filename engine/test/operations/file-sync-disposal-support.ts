import {
  type FileSyncDisposalOperation,
  type FileSyncDisposalPhase,
  fileSyncDisposalTransitions,
} from "@lando/sdk/schema";
import { illegalTransitionMessage } from "@lando/sdk/transitions";
import { Effect } from "effect";

/**
 * Phase holder for an in-memory `FileSyncEngine.appLifecycle` double. Every
 * move goes through the SDK's declared edge table, so a double cannot accept a
 * transition the contract forbids; an illegal operation dies like an engine bug.
 */
export const disposalPhaseTracker = (initial: FileSyncDisposalPhase = "active") => {
  let phase = initial;
  return {
    phase: (): FileSyncDisposalPhase => phase,
    apply: (operation: FileSyncDisposalOperation): Effect.Effect<void> =>
      Effect.suspend(() => {
        const verdict = fileSyncDisposalTransitions.step(operation, phase);
        switch (verdict._tag) {
          case "Advance":
            phase = verdict.to;
            return Effect.void;
          case "Settled":
            return Effect.void;
          case "Illegal":
            return Effect.die(illegalTransitionMessage("Test file sync app", operation, verdict));
          default: {
            const exhaustive: never = verdict;
            return Effect.die(exhaustive);
          }
        }
      }),
  };
};
