import { Effect } from "effect";
import { limits } from "./diagnostics.ts";

export interface BoundedReader {
  readonly size: number;
  readonly read: (buffer: Uint8Array) => Promise<number>;
}
export const readBounded = Effect.fn("WorkflowAcquisition.readBounded")(function* (
  reader: BoundedReader,
  remaining: number,
) {
  const budget = Math.min(limits.fileBytes, remaining);
  if (reader.size > limits.fileBytes) return { status: "file-limit" as const, bytes: 0 };
  const bytes = new Uint8Array(budget);
  let used = 0;
  let ended = false;
  while (used < budget) {
    const result = yield* Effect.tryPromise({
      try: () => reader.read(bytes.subarray(used)),
      catch: () => "unreadable-file" as const,
    }).pipe(Effect.result);
    if (result._tag === "Failure") return { status: "unreadable-file" as const, bytes: used };
    const size = result.success;
    if (size === 0) {
      ended = true;
      break;
    }
    used += size;
  }
  // The host checks the opened file's size and identity again after this read.
  // No lookahead byte may escape either byte budget, even if a file grows.
  if (!ended && reader.size !== used)
    return {
      status: budget === limits.fileBytes ? ("file-limit" as const) : ("aggregate-limit" as const),
      bytes: used,
    };
  return yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
    catch: () => "invalid-encoding" as const,
  }).pipe(
    Effect.match({
      onSuccess: (content) => ({ status: "read" as const, content, bytes: used }),
      onFailure: (status) => ({ status, bytes: used }),
    }),
  );
});
