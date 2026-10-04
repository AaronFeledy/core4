import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/** Inert Effect HttpClient for plugin-context fixtures that do not exercise egress. */
export const stubHttpClient = (): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
  );
