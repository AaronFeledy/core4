import { expect, test } from "bun:test";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { bringDown } from "../src/podman/bring-down.ts";

test("publishes paired stop events for each service when containers are already absent", async () => {
  // Given two planned services whose containers and private network are absent.
  const metadata = { source: "bring-down-events", runtime: 4 as const, resolvedAt: DateTime.makeUnsafe(0) };
  const provider = ProviderId.make("lando");
  const services = [ServiceName.make("web"), ServiceName.make("database")].map((name) => ({
    name,
    type: "node",
    provider,
    primary: name === "web",
    artifact: { kind: "ref" as const, ref: "node:22" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    extensions: {},
    metadata,
  }));
  const plan: AppPlan = {
    id: AppId.make("absent"),
    name: "Absent",
    slug: "absent",
    root: AbsolutePath.make("/absent"),
    provider,
    services: Object.fromEntries(services.map((service) => [service.name, service])),
    networks: [],
    stores: [],
    routes: [],
    fileSync: [],
    extensions: {},
    metadata,
  };
  const requests: EngineHttpRequest[] = [];
  const events: LandoEvent[] = [];
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return { status: 404, body: "" };
      }),
  };

  // When
  const result = await Effect.runPromise(
    bringDown(plan, {
      api,
      ctx: { providerId: "lando", remediation: "retry" },
      eventService: {
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      },
    }),
  );

  // Then
  expect(events.map((event) => event._tag)).toEqual([
    "pre-service-stop",
    "post-service-stop",
    "pre-service-stop",
    "post-service-stop",
  ]);
  for (const service of services) {
    expect(
      events
        .filter((event) => "serviceName" in event && event.serviceName === service.name)
        .map((event) => event._tag),
    ).toEqual(["pre-service-stop", "post-service-stop"]);
  }
  expect(result).toEqual({ changed: false });
  expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    "GET /containers/lando-absent-database/json",
    "GET /containers/lando-absent-web/json",
    "GET /networks/lando-absent",
  ]);
});
