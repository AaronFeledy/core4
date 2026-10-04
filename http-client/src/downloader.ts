/**
 * Verified-artifact Downloader over Effect's `HttpClient`.
 *
 * Issues every byte through `HttpClient.get` + `response.stream` with a
 * fiber-local `RequestPolicy` (`onBehalfOf: "downloader"`). Adds checksum/size
 * verification, atomic temp-file persistence, cache/offline short-circuiting,
 * and scheme gating on top of that egress path.
 */
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { Downloader, EventService } from "@lando/sdk/services";

import { makeDownloaderEvents } from "./downloader-events.ts";
import { makeDownloaderService } from "./downloader-service.ts";

export type { DownloaderEvents } from "./downloader-events.ts";
export { makeDownloaderEvents } from "./downloader-events.ts";
export { makeDownloaderService } from "./downloader-service.ts";

/** Live Downloader layer; requires Effect `HttpClient` in the environment. */
export const layer: Layer.Layer<Downloader, never, HttpClient.HttpClient> = Layer.effect(
  Downloader,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const eventService = yield* Effect.serviceOption(EventService);
    return Downloader.of(makeDownloaderService(http, makeDownloaderEvents(eventService)));
  }),
);
