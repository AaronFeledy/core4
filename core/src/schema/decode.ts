import { Effect, Either, type ParseResult, Schema } from "effect";

type DecodeOptions = Parameters<ReturnType<typeof Schema.decodeUnknownEither>>[1];

export const decodeOrFail = <A, I, E>(
  schema: Schema.Schema<A, I, never>,
  onError: (cause: ParseResult.ParseError) => E,
) =>
(input: unknown, options?: DecodeOptions): Effect.Effect<A, E> => {
  const result = Schema.decodeUnknownEither(schema)(input, options);
  return Either.isRight(result) ? Effect.succeed(result.right) : Effect.fail(onError(result.left));
};
