import { tryPromiseSettled } from "@lando/sdk/abortable-promise";
import type { Effect } from "effect";
import { type SourceAcquisitionError, acquisitionError } from "./errors.ts";

export const acquireTransport = <A>(
  source: string,
  body: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, SourceAcquisitionError> =>
  tryPromiseSettled({
    try: body,
    catch: (cause) => acquisitionError("fetch-failed", source, cause),
  });
