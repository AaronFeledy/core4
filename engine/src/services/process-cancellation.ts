import { Effect } from "effect";

// Do not use the caller's abort reason as proof: another error can arrive after a signal.
export class ProcessCancellation extends DOMException {
  constructor() {
    super("Host process cancelled.", "AbortError");
  }
}

export const processCancellation = new ProcessCancellation();

/** Use only at a native rejection boundary, before scope cleanup can add reasons. */
export const processRejection = <E>(error: E | ProcessCancellation): Effect.Effect<never, E> =>
  error instanceof ProcessCancellation ? Effect.interrupt : Effect.fail(error);
