import type { PortNumber } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { RouteSnapshot } from "../src/route-evidence-match.ts";

const Config = Schema.Struct({
  http: Schema.Struct({
    routers: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    services: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    middlewares: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    ),
  }),
});
const EntryPoints = Schema.Struct({ entryPoints: Schema.Array(Schema.String) });

export const persistedRuntimeGraph = (files: ReadonlyMap<string, string>): RouteSnapshot => {
  const routers: Record<string, Readonly<Record<string, unknown>>> = {};
  const services: Record<string, Readonly<Record<string, unknown>>> = {};
  const middlewares: Record<string, unknown> = {};
  for (const [path, content] of files) {
    if (!/routes-[^/\\]+\.yml$/.test(path)) continue;
    const { http } = Schema.decodeUnknownSync(Config)(Bun.YAML.parse(content));
    for (const [name, router] of Object.entries(http.routers)) {
      const { entryPoints } = Schema.decodeUnknownSync(EntryPoints)(router);
      routers[`${name}@file`] = { ...router, status: "enabled", using: entryPoints };
    }
    for (const [name, service] of Object.entries(http.services))
      services[`${name}@file`] = { ...service, status: "enabled" };
    for (const [name, middleware] of Object.entries(http.middlewares ?? {}))
      middlewares[`${name}@file`] = { ...middleware, status: "enabled" };
  }
  return { routers, services, middlewares };
};

export const makeApplyRuntime = (files: ReadonlyMap<string, string>) => {
  let graph: RouteSnapshot | undefined;
  const requests: string[] = [];
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      return HttpClientResponse.fromWeb(request, Response.json(graph ?? persistedRuntimeGraph(files)));
    }),
  );
  return {
    httpClient,
    requests,
    ownedPublishPorts: (_service: unknown, ports: ReadonlyArray<PortNumber>) => Effect.succeed(ports),
    setGraph: (next: RouteSnapshot) => {
      graph = next;
    },
    followPersisted: () => {
      graph = undefined;
    },
  };
};
