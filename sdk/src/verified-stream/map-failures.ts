import { Effect } from "effect";
import { failureOutcomeFromCause, mapDefectCause, mapFailureCause } from "../command-result/failure.ts";
import { VerifiedStreamError } from "./errors.ts";

/** Translate verification diagnostics without making a mixed cause recoverable. */
export const mapVerifiedStreamFailures =
  <E2>(wrap: (error: VerifiedStreamError) => E2) =>
  <A, E, R>(self: Effect.Effect<A, E | VerifiedStreamError, R>): Effect.Effect<A, E | E2, R> =>
    Effect.catchCause(self, (cause) => {
      const primary = failureOutcomeFromCause(cause);
      const mapped = mapFailureCause(cause, (error) =>
        error instanceof VerifiedStreamError ? wrap(error) : error,
      );
      if (
        primary.kind !== "typed" ||
        primary.source !== "elected" ||
        !(primary.error instanceof VerifiedStreamError)
      )
        return Effect.failCause(mapped);

      const verified = primary.error;
      return Effect.failCause(
        mapDefectCause(mapped, (defect, role) =>
          role === undefined && defect === verified ? wrap(verified) : defect,
        ),
      );
    });
