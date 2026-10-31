import { expect, test } from "bun:test";
import { layerWith } from "@lando/http-client";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { acquisition, app, liveGraph, makeObserveFixture, route } from "./observe-routes-fixture.ts";

test.each(["live", "malformed", "redirect"] as const)(
  "uses injected HTTP end-to-end with %s API response and private telemetry",
  async (kind) => {
    const fixture = makeObserveFixture();
    const requests: Array<{ readonly path: string; readonly host: string | null }> = [];
    const events: LandoEvent[] = [];
    const canary = "raw-api-secret-canary";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        requests.push({ path, host: request.headers.get("host") });
        if (path === "/") return new Response("fallback", { status: 404 });
        switch (kind) {
          case "live":
            return Response.json({ ...liveGraph(), sensitive: canary });
          case "malformed":
            return new Response(`{${canary}`, { headers: { "content-type": "application/json" } });
          case "redirect":
            return new Response(canary, { status: 302, headers: { location: "/other" } });
          default:
            return kind satisfies never;
        }
      },
    });
    try {
      const port = server.port;
      if (port === undefined) throw new Error("TCP fixture needs a port");
      fixture.files.set(
        acquisitionStateFile(fixture.paths),
        JSON.stringify({ ...acquisition, httpPort: port }),
      );
      const { probeForward: _probe, httpClient: _client, ...dependencies } = fixture.dependencies;
      const evidence = await Effect.runPromise(
        Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;
          return yield* makeTraefikRouterService({ ...dependencies, httpClient }).observeRoutes(app, [
            { ...route, scheme: "http" },
          ]);
        }).pipe(
          Effect.provide(layerWith({ env: {} })),
          Effect.provideService(
            EventService,
            EventService.of({
              publish: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
              subscribe: () => Stream.empty,
              subscribeQueue: Effect.never,
              waitFor: () => Effect.never,
              subscribeWithHistory: () => Effect.never,
              waitForAny: () => Effect.never,
              query: () => Effect.succeed([]),
            }),
          ),
        ),
      );
      expect(evidence.observation.status).toBe(kind === "live" ? "present" : "unknown");
      expect(requests).toEqual([
        { path: "/", host: `traefik.example.test:${port}` },
        { path: "/api/rawdata", host: `traefik.example.test:${port}` },
      ]);
      expect(events.filter((event) => event._tag === "post-http-call")).toHaveLength(2);
      expect(JSON.stringify({ evidence, events })).not.toContain(canary);
      expect(fixture.mutations).toEqual([]);
    } finally {
      await server.stop(true);
    }
  },
);

test.each([200, 503])("releases the scoped API request after status %s", async (status) => {
  const fixture = makeObserveFixture();
  const signals: AbortSignal[] = [];
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    httpClient: HttpClient.make((request, _url, signal) => {
      signals.push(signal);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(liveGraph(), { status })));
    }),
  });
  const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
  expect(evidence.observation.status).toBe(status === 200 ? "present" : "unknown");
  expect(signals).toHaveLength(1);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
