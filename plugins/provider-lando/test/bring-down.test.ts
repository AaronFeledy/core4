import { describe, expect, test } from "bun:test";
import type { EngineHttpRequest, PodmanApiClient } from "@lando/container-runtime/engine-api";
import { bringDown } from "@lando/provider-lando";
import { AppId, type AppPlan, ServiceName } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";
import { Effect } from "effect";
import { bringUp } from "./provider-fixture.ts";
import { appRoot, makeFakeApi, plan, servicePlan, volumeSelector } from "./support/bring-down-fixture.ts";

describe("provider-lando bringDown", () => {
  test("stops and removes every service, removes the app network, preserves volumes, and is idempotent", async () => {
    const fake = makeFakeApi();
    const events: LandoEvent[] = [];
    const eventService = {
      publish: (event: LandoEvent) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
    };

    await Effect.runPromise(bringUp(plan, { api: fake.api }));
    const first = await Effect.runPromise(bringDown(plan, { api: fake.api, eventService }));
    const second = await Effect.runPromise(bringDown(plan, { api: fake.api, eventService }));

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(fake.existing.size).toBe(0);
    expect(Array.from(fake.networks)).toEqual(["lando_bridge_network"]);
    expect(fake.volumes.has("bringdownapp_database_data")).toBe(true);
    expect(fake.volumes.has("lando-cache-npm")).toBe(true);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/volumes/"))).toBe(
      false,
    );
    expect(events.map((event) => event._tag)).toEqual([
      "pre-service-stop",
      "post-service-stop",
      "pre-service-stop",
      "post-service-stop",
      "pre-service-stop",
      "post-service-stop",
      "pre-service-stop",
      "post-service-stop",
    ]);
  });

  test("global stop failures suggest global cleanup without claiming app volume flags", async () => {
    const globalPlan: AppPlan = {
      ...plan,
      id: AppId.make("global"),
      slug: "global",
      services: { [ServiceName.make("node")]: servicePlan("node") },
      stores: [],
    };
    const failedStopApi: PodmanApiClient = {
      info: Effect.succeed({}),
      ping: Effect.succeed(undefined),
      request: (request) =>
        Effect.sync(() => {
          if (request.method === "GET" && request.path.endsWith("/json")) {
            const global = request.path === "/containers/lando-global--node/json";
            return {
              status: 200,
              body: JSON.stringify({
                Id: global ? "global-node-id" : "app-node-id",
                Config: {
                  Labels: {
                    "dev.lando.app": global ? globalPlan.id : plan.id,
                    "dev.lando.app-root": appRoot,
                    "dev.lando.service": "node",
                  },
                },
              }),
            };
          }
          if (request.method === "POST" && request.path.endsWith("/stop")) {
            return { status: 500, body: "stop failed" };
          }
          if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
            return { status: 200, body: "[]" };
          }
          return { status: 500, body: `unexpected ${request.method} ${request.path}` };
        }),
    };

    const globalError = await Effect.runPromise(
      bringDown(globalPlan, { api: failedStopApi }).pipe(Effect.flip),
    );
    expect(globalError._tag).toBe("ProviderUnavailableError");
    expect(globalError.remediation).toContain("lando global:stop");
    expect(globalError.remediation).toContain("lando global:destroy");
    expect(globalError.remediation).toContain("--purge");
    expect(globalError.remediation).not.toContain("lando destroy");
    expect(globalError.remediation).not.toContain("--volumes");

    const appError = await Effect.runPromise(bringDown(plan, { api: failedStopApi }).pipe(Effect.flip));
    expect(appError.remediation).toContain("lando destroy");
    expect(appError.remediation).toContain("--volumes");
  });

  test("purgeCaches removes cache volumes without removing app data volumes", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { api: fake.api }));
    await Effect.runPromise(bringDown(plan, { api: fake.api, volumes: false, purgeCaches: true }));

    expect(fake.volumes.has("bringdownapp_database_data")).toBe(true);
    expect(fake.volumes.has("lando-cache-npm")).toBe(false);
  });

  test("does not directly delete a planned volume owned by another app", async () => {
    const foreignPlan: AppPlan = {
      ...plan,
      services: {},
      stores: [{ name: "foreign-data", scope: "app", kind: "data" }],
    };
    const calls: EngineHttpRequest[] = [];
    const api: PodmanApiClient = {
      info: Effect.succeed({}),
      ping: Effect.succeed(undefined),
      request: (request) =>
        Effect.sync(() => {
          calls.push(request);
          if (request.method === "GET" && request.path.startsWith("/networks/")) {
            return { status: 404, body: "" };
          }
          if (request.method === "GET" && request.path === "/volumes/foreign-data") {
            return {
              status: 200,
              body: JSON.stringify({
                Labels: { "dev.lando.volume-selector": volumeSelector("otherapp", "data") },
              }),
            };
          }
          if (request.method === "DELETE" && request.path === "/volumes/foreign-data") {
            return { status: 204, body: "" };
          }
          if (request.method === "POST" && request.path.startsWith("/libpod/volumes/prune")) {
            return { status: 200, body: "[]" };
          }
          if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
            return { status: 200, body: "[]" };
          }
          return { status: 500, body: `unexpected ${request.method} ${request.path}` };
        }),
    };

    await Effect.runPromise(bringDown(foreignPlan, { api, volumes: true }));

    expect(calls).toContainEqual({ method: "GET", path: "/volumes/foreign-data" });
    expect(calls).not.toContainEqual({ method: "DELETE", path: "/volumes/foreign-data" });
  });

  test("purgeCaches-only prune is cache-label positive and cannot match ordinary app volumes", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { api: fake.api }));
    await Effect.runPromise(bringDown(plan, { api: fake.api, purgeCaches: true }));

    const prune = fake.calls.find((call) => call.path.startsWith("/libpod/volumes/prune"));
    expect(prune).toBeDefined();
    const filters = JSON.parse(
      decodeURIComponent(new URL(`http://localhost${prune?.path ?? ""}`).searchParams.get("filters") ?? "{}"),
    ) as Record<string, readonly string[]>;
    expect(filters.label).toEqual([`dev.lando.volume-selector=${volumeSelector(plan.id, "cache")}`]);
    expect(filters["label!"]).toBeUndefined();
    expect(filters.all).toBeUndefined();
  });

  test("volumes cleanup prunes only current app/provider-scoped volumes with named-volume intent", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { api: fake.api }));
    await Effect.runPromise(bringDown(plan, { api: fake.api, volumes: true }));

    const prune = fake.calls.find((call) => call.path.startsWith("/libpod/volumes/prune"));
    expect(prune).toBeDefined();
    const pruneUrl = new URL(`http://localhost${prune?.path ?? ""}`);
    const filters = JSON.parse(decodeURIComponent(pruneUrl.searchParams.get("filters") ?? "{}")) as Record<
      string,
      readonly string[]
    >;
    expect(filters.label).toEqual([`dev.lando.volume-selector=${volumeSelector(plan.id, "data")}`]);
    expect(filters.all).toBeUndefined();
    expect(pruneUrl.searchParams.get("all")).toBe("true");
  });

  test("volumes cleanup with purgeCaches ORs only fully ownership-scoped cache and data selectors", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { api: fake.api }));
    await Effect.runPromise(bringDown(plan, { api: fake.api, volumes: true, purgeCaches: true }));

    const prune = fake.calls.find((call) => call.path.startsWith("/libpod/volumes/prune"));
    expect(prune).toBeDefined();
    const pruneUrl = new URL(`http://localhost${prune?.path ?? ""}`);
    const filters = JSON.parse(decodeURIComponent(pruneUrl.searchParams.get("filters") ?? "{}")) as Record<
      string,
      readonly string[]
    >;
    expect(filters.label).toEqual([
      `dev.lando.volume-selector=${volumeSelector(plan.id, "cache")}`,
      `dev.lando.volume-selector=${volumeSelector(plan.id, "data")}`,
    ]);
    expect(filters.all).toBeUndefined();
    expect(pruneUrl.searchParams.get("all")).toBe("true");
  });

  test("default cleanup does not prune named volumes without explicit destructive intent", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { api: fake.api }));
    await Effect.runPromise(bringDown(plan, { api: fake.api }));

    expect(fake.calls.some((call) => call.path.startsWith("/libpod/volumes/prune"))).toBe(false);
  });
});
