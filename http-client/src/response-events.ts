import { Cause, Effect, type Exit, Option, Stream } from "effect";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

export const observeResponse = (
  response: HttpClientResponse.HttpClientResponse,
  complete: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>,
): HttpClientResponse.HttpClientResponse =>
  new Proxy(response, {
    get(target, key) {
      switch (key) {
        case "stream":
          return Stream.onExit(target.stream, complete);
        case "text":
          return Effect.onExit(target.text, complete);
        case "json":
          return Effect.onExit(target.json, complete);
        case "arrayBuffer":
          return Effect.onExit(target.arrayBuffer, complete);
        case "formData":
          return Effect.onExit(target.formData, complete);
        case "urlParamsBody":
          return Effect.onExit(target.urlParamsBody, complete);
        default:
          return Reflect.get(target, key, target);
      }
    },
  });

export const failureDetail = (exit: Exit.Failure<unknown, unknown>): string => {
  if (Cause.hasInterruptsOnly(exit.cause)) return "body-read-interrupted";
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) && error.value instanceof Error ? error.value.message : "body-read-failed";
};
