import { Effect, Stream } from "effect";
import { TAR_BLOCK_SIZE } from "./tar.ts";

export const extractFirstTarFile = <E, R, E2>(
  source: Stream.Stream<Uint8Array, E, R>,
  extractionError: (cause: RangeError) => E2,
): Stream.Stream<Uint8Array, E | E2, R> =>
  Stream.suspend(() => {
    let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let remaining: number | undefined;
    const content = source.pipe(
      Stream.mapEffect((chunk) => {
        if (remaining === 0) return Effect.succeed(new Uint8Array());
        const joined = new Uint8Array(buffered.byteLength + chunk.byteLength);
        joined.set(buffered);
        joined.set(chunk, buffered.byteLength);
        buffered = joined;
        if (remaining === undefined) {
          if (buffered.byteLength < TAR_BLOCK_SIZE) return Effect.succeed(new Uint8Array());
          const raw = new TextDecoder().decode(buffered.subarray(124, 136)).replaceAll("\0", "").trim();
          remaining = raw.length === 0 ? 0 : Number.parseInt(raw, 8);
          if (!Number.isSafeInteger(remaining) || remaining < 0) {
            return Effect.fail(extractionError(new RangeError("Invalid tar payload size.")));
          }
          buffered = buffered.subarray(TAR_BLOCK_SIZE);
        }
        const count = Math.min(remaining, buffered.byteLength);
        const output = buffered.subarray(0, count);
        buffered = buffered.subarray(count);
        remaining -= count;
        return Effect.succeed(output);
      }),
      Stream.filter((chunk) => chunk.byteLength > 0),
    );
    return Stream.concat(
      content,
      Stream.fromEffect(
        Effect.suspend(() =>
          remaining === undefined || remaining !== 0
            ? Effect.fail(extractionError(new RangeError("Truncated tar payload.")))
            : Effect.void,
        ),
      ).pipe(Stream.drain),
    );
  });
