import { Effect, Result, Schema } from "effect";

type DecodeOptions = Parameters<ReturnType<typeof Schema.decodeUnknownResult>>[1];

export const decodeOrFail =
  <A, I, E>(schema: Schema.Codec<A, I, never, never>, onError: (cause: Schema.SchemaError) => E) =>
  (input: unknown, options?: DecodeOptions): Effect.Effect<A, E> => {
    const result = Schema.decodeUnknownResult(schema)(input, options);
    return Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(onError(result.failure));
  };
