import type { makeTraefikRouterService } from "@lando/proxy-traefik";
import type { PortNumber, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const Config = Schema.Struct({
  http: Schema.Struct({
    routers: Schema.Record(
      Schema.String,
      Schema.StructWithRest(Schema.Struct({ entryPoints: Schema.Array(Schema.String) }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
    services: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    middlewares: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    ),
  }),
});

type FixtureFileSystem = Pick<
  Parameters<typeof makeTraefikRouterService>[0]["fileSystem"],
  "readDir" | "readText"
>;

// Model the file provider at the HTTP boundary, independently of route matching.
// Read every app's current file on each request so replacement/withdrawal cannot
// be accepted using a cached graph or the routes requested by the caller.
export const makeTraefikApiFixture = (fileSystem: FixtureFileSystem, dynamicDirectory: string) => {
  const snapshots: { readonly url: string; readonly routers: readonly string[] }[] = [];
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (new URL(request.url).pathname !== "/api/rawdata") {
        return HttpClientResponse.fromWeb(request, new Response(null));
      }
      const routers: Record<string, unknown> = {};
      const services: Record<string, unknown> = {};
      const middlewares: Record<string, unknown> = {};
      const files = yield* fileSystem.readDir(dynamicDirectory);
      for (const file of files.filter((name) => /^routes-[^/\\]+\.yml$/.test(name))) {
        const content = yield* fileSystem.readText(`${dynamicDirectory}/${file}`);
        const { http } = Schema.decodeUnknownSync(Config)(Bun.YAML.parse(content));
        for (const [name, router] of Object.entries(http.routers)) {
          routers[`${name}@file`] = { ...router, status: "enabled", using: router.entryPoints };
        }
        for (const [name, service] of Object.entries(http.services)) {
          services[`${name}@file`] = { ...service, status: "enabled" };
        }
        for (const [name, middleware] of Object.entries(http.middlewares ?? {})) {
          middlewares[`${name}@file`] = { ...middleware, status: "enabled" };
        }
      }
      snapshots.push({ url: request.url, routers: Object.keys(routers) });
      return HttpClientResponse.fromWeb(request, Response.json({ routers, services, middlewares }));
    }).pipe(Effect.orDie),
  );
  return {
    httpClient,
    snapshots,
    ownedPublishPorts: (_service: ServiceName, ports: ReadonlyArray<PortNumber>) => Effect.succeed(ports),
  };
};
