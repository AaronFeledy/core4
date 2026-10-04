import { Effect, Stream } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

export const requestBody = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
  const body = request.body;
  switch (body._tag) {
    case "Empty":
      return undefined;
    case "Raw": {
      const raw = body.body;
      if (
        typeof raw === "string" ||
        raw instanceof Uint8Array ||
        raw instanceof ArrayBuffer ||
        raw instanceof Blob ||
        raw instanceof FormData ||
        raw instanceof URLSearchParams ||
        raw instanceof ReadableStream
      )
        return raw;
      return yield* Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.EncodeError({
            request,
            description: "Unsupported raw request body",
            cause: raw,
          }),
        }),
      );
    }
    case "Uint8Array":
      return body.body;
    case "FormData":
      return body.formData;
    case "Stream":
      return yield* Stream.toReadableStreamEffect(body.stream);
    default:
      return yield* Effect.die(body satisfies never);
  }
});
