import { describe, expect, test } from "bun:test";
import type { AppPlan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Result } from "effect";
import { makeProviderDataPlane } from "../src/data-plane.ts";
import { dockerLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpRequest } from "../src/engine-api.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { volumeOwnershipLabels } from "../src/volume-ownership.ts";
import { networkPlan } from "./authored-network-fixture.ts";

const data = { name: "data", scope: "app", kind: "data" } as const;
const cache = { name: "cache", scope: "app", kind: "cache" } as const;
const global = { name: "global", scope: "global", kind: "data" } as const;
const basePlan = { ...networkPlan, services: {}, stores: [data, cache, global] } satisfies AppPlan;
const redactor = {
  redactString: (value: string) => value.replaceAll("SENSITIVE", "[REDACTED]"),
  redactValue: (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replaceAll("SENSITIVE", "[REDACTED]")),
} satisfies Redactor;
const helper = (state: string, labels: Readonly<Record<string, string>>) => ({
  Id: "exact-SENSITIVE-id",
  Names: ["/lando-docker-data-SENSITIVE"],
  State: state,
  Labels: labels,
  Mounts: [{ Type: "volume", Name: "data" }],
});

const makeApi = (plan: AppPlan, holders: ReadonlyArray<unknown> = []) => {
  const calls: EngineHttpRequest[] = [];
  const request = (input: EngineHttpRequest) =>
    Effect.sync(() => {
      calls.push(input);
      if (input.method === "GET" && input.path.startsWith("/networks/")) return { status: 404, body: "" };
      if (input.method === "GET" && input.path.startsWith("/containers/json?"))
        return { status: 200, body: JSON.stringify(holders) };
      const store = plan.stores.find((candidate) => input.path === `/volumes/${candidate.name}`);
      if (store !== undefined && input.method === "GET")
        return { status: 200, body: JSON.stringify({ Labels: volumeOwnershipLabels(plan, store) }) };
      if (store !== undefined && input.method === "DELETE")
        return { status: 409, body: JSON.stringify({ message: "SENSITIVE volume in use" }) };
      return { status: 500, body: "Unexpected request" };
    });
  return { request, calls };
};

const down = (
  plan: AppPlan,
  options: { readonly volumes?: boolean; readonly purgeCaches?: boolean },
  holders: ReadonlyArray<unknown> = [],
) => {
  const api = makeApi(plan, holders);
  return {
    api,
    effect: bringDown(plan, {
      api,
      ctx: { providerId: "docker", remediation: "Retry.", env: {}, redactor },
      dialect: dockerLifecycleDialect,
      ...options,
    }).pipe(Effect.result),
  };
};

describe("volume holder preservation during teardown", () => {
  test.each([
    { stores: [], options: { volumes: true } },
    { stores: [cache], options: { volumes: true } },
    { stores: [global], options: { volumes: true } },
    { stores: [data], options: { purgeCaches: true } },
  ] as const)("empty selection never discovers or sweeps helpers: %j", async ({ stores, options }) => {
    const { api, effect } = down({ ...basePlan, stores }, options);
    expect(await Effect.runPromise(effect)).toMatchObject({ _tag: "Success", success: { changed: false } });
    expect(api.calls.every((call) => call.method === "GET" && call.path.startsWith("/networks/"))).toBe(true);
  });

  test("cache-only purge touches only its selected cache volume", async () => {
    const { api, effect } = down(basePlan, { purgeCaches: true });
    const result = await Effect.runPromise(effect);
    expect(Result.isFailure(result)).toBe(true);
    expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/volumes/cache",
    ]);
    expect(api.calls.some((call) => call.path === "/volumes/data")).toBe(false);
  });

  test.each([
    [
      "created",
      {
        "dev.lando.role": "data-helper",
        "dev.lando.app": "networks",
        "dev.lando.provider": "docker",
        "dev.lando.store": "data",
      },
    ],
    ["running", { "dev.lando.role": "data-helper" }],
    ["exited", { "dev.lando.role": "data-helper", "dev.lando.app": "foreign" }],
    ["exited", {}],
    ["dead", {}],
    ["uncertain", {}],
  ] as const)("preserves %s helpers, including unlabeled and foreign holders", async (state, labels) => {
    const { api, effect } = down(basePlan, { volumes: true }, [helper(state, labels)]);
    const result = await Effect.runPromise(effect);
    expect(result).toMatchObject({ _tag: "Failure", failure: { operation: "bringDown.volume" } });
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain("lando-docker-data-[REDACTED] (exact-[REDACTED]-id)");
    expect(result.failure.remediation).toContain("cannot verify that a leftover helper is inactive");
    expect(JSON.stringify(result.failure)).not.toContain("SENSITIVE");
    expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/volumes/data",
    ]);
  });

  test("direct removal retains the generation check and reports holders without mutating them", async () => {
    const generation = "00000000-0000-4000-8000-000000000001";
    const calls: EngineHttpRequest[] = [];
    const plane = makeProviderDataPlane({
      providerId: "docker",
      capabilities: { volumeSnapshot: "none" },
      redactor,
      api: {
        request: (input) =>
          Effect.sync(() => {
            calls.push(input);
            if (input.path === "/volumes/data" && input.method === "GET")
              return {
                status: 200,
                body: JSON.stringify({ Name: "data", Labels: { "dev.lando.volume-instance": generation } }),
              };
            if (input.path === "/volumes/data" && input.method === "DELETE")
              return { status: 409, body: "SENSITIVE is in use" };
            return { status: 200, body: JSON.stringify([helper("created", {})]) };
          }),
      },
    });
    const result = await Effect.runPromise(
      plane.removeVolume({ app: basePlan.id, store: "data" }, generation).pipe(Effect.result),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { operation: "removeVolume" } });
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain("exact-[REDACTED]-id");
    expect(JSON.stringify(result.failure)).not.toContain("SENSITIVE");
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(calls[1]?.path).toBe("/volumes/data");
  });
});
