import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  planAppIdentity,
} from "@lando/sdk/schema";
import { DateTime, Effect, Result } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import { privateNetworkLabels } from "../src/resource-cleanup.ts";

const metadata = { source: "ownership-test", runtime: 4 as const, resolvedAt: DateTime.makeUnsafe(0) };
const web = ServiceName.make("web");
const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("owned"),
  name: "owned",
  slug: "owned",
  root: AbsolutePath.make("/owned"),
  provider: ProviderId.make("docker"),
  services: {
    [web]: {
      name: web,
      type: "node",
      provider: ProviderId.make("docker"),
      primary: true,
      artifact: { kind: "ref", ref: "node:22" },
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      extensions: {},
      metadata,
    },
  },
  networking: {
    perAppBridge: { name: "private", driver: "bridge" },
    sharedNetworkMembership: { name: "shared", aliases: {} },
  },
  networks: [],
  stores: [],
  routes: [],
  fileSync: [],
  extensions: {},
  metadata,
};
const service = plan.services[web];
if (service === undefined) throw new TypeError("Missing fixture service");
const ownedLabels = commonContainerLabels(plan, service);
const networkLabels = privateNetworkLabels({
  ...planAppIdentity(plan),
  appId: plan.id,
  providerId: plan.provider,
});
const ctx = { providerId: "docker", remediation: "retry" };

const fakeApi = (observations: ReadonlyMap<string, object>) => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        calls.push(request);
        if (request.method !== "GET") return { status: 204, body: "" };
        const observed = observations.get(request.path);
        return observed === undefined
          ? { status: 404, body: "" }
          : { status: 200, body: JSON.stringify(observed) };
      }),
  };
  return { api, calls };
};

for (const labels of [
  {},
  { ...ownedLabels, "dev.lando.app": "foreign" },
  { ...ownedLabels, "dev.lando.app-root": "/foreign" },
  { ...ownedLabels, "dev.lando.service": "foreign" },
]) {
  test(`bring-down refuses replacement container ownership ${JSON.stringify(labels)}`, async () => {
    // Given an owned slot replaced by a different native object at the same name.
    const observations = new Map<string, object>([
      ["/containers/lando-owned-web/json", { Id: "original", Config: { Labels: ownedLabels } }],
    ]);
    observations.set("/containers/lando-owned-web/json", { Id: "replacement", Config: { Labels: labels } });
    const fake = fakeApi(observations);
    // When
    const result = await Effect.runPromise(bringDown(plan, { api: fake.api, ctx }).pipe(Effect.result));
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
    expect(fake.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test(`config recreate refuses replacement ownership ${JSON.stringify(labels)}`, async () => {
    // Given config drift on a foreign or unknown object in the planned slot.
    const fake = fakeApi(
      new Map([
        ["/networks/private", { Id: "private-id", Labels: networkLabels }],
        ["/networks/shared", { Id: "shared-id" }],
        [
          "/containers/lando-owned-web/json",
          { Id: "replacement", Config: { Labels: labels }, State: { Running: true } },
        ],
      ]),
    );
    // When
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }).pipe(Effect.result));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(
      fake.calls.filter((call) => call.path.startsWith("/containers/") && call.method !== "GET"),
    ).toEqual([]);
  });
}

for (const labels of [
  { "dev.lando.app": plan.id },
  { unrelated: "label" },
  { ...networkLabels, unrelated: "label" },
  { ...networkLabels, "dev.lando.app-root": "/foreign" },
  { ...networkLabels, "dev.lando.owner": "foreign" },
  { ...networkLabels, "dev.lando.provider": "foreign" },
  { ...networkLabels, "dev.lando.app": "foreign" },
]) {
  test(`bring-down refuses foreign network ${JSON.stringify(labels)}`, async () => {
    // Given
    const fake = fakeApi(new Map([["/networks/private", { Id: "replacement-network", Labels: labels }]]));
    // When
    const result = await Effect.runPromise(
      bringDown({ ...plan, services: {} }, { api: fake.api, ctx }).pipe(Effect.result),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
    expect(fake.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
}

for (const legacy of [{ Labels: {} }, { Labels: null }, {}]) {
  test(`bring-down removes an entirely unlabeled legacy network at the planned private name by observed Id ${JSON.stringify(legacy)}`, async () => {
    // Given
    const fake = fakeApi(
      new Map([["/networks/private", { Id: "legacy-network", Name: "private", ...legacy }]]),
    );
    // When
    await Effect.runPromise(bringDown({ ...plan, services: {} }, { api: fake.api, ctx }));
    // Then
    expect(fake.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/networks/legacy-network",
    ]);
  });
}

test("bring-up failure retains a legacy unlabeled private network and never mutates the shared one", async () => {
  // Given: foreign container blocks create; legacy private network was observed.
  const fake = fakeApi(
    new Map([
      ["/networks/private", { Id: "legacy-network", Name: "private", Labels: {} }],
      ["/networks/shared", { Id: "shared-network", Labels: {} }],
      ["/containers/lando-owned-web/json", { Id: "foreign", Config: { Labels: {} } }],
    ]),
  );
  // When
  const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }).pipe(Effect.result));
  // Then: no compensation teardown — retention leaves networks untouched for inventory cleanup.
  expect(Result.isFailure(result)).toBe(true);
  expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([]);
});

for (const path of ["bring-up", "bring-down"] as const) {
  test.each(["lando_bridge_network", undefined])(
    `refuses unlabeled network aliases (${path}): %s`,
    async (name) => {
      // Given a private name resolved as another network's ID prefix or without name evidence.
      const aliased = {
        ...plan,
        networking: { ...plan.networking, perAppBridge: { name: "abcdef123456", driver: "bridge" } },
      };
      const fake = fakeApi(
        new Map([
          ["/networks/abcdef123456", { Id: "abcdef1234567890", Name: name, Labels: {} }],
          ["/networks/shared", { Id: "shared-network", Labels: {} }],
          ["/containers/lando-owned-web/json", { Id: "foreign", Config: { Labels: {} } }],
        ]),
      );
      // When bring-up fails closed or bring-down validates ownership.
      const result = await Effect.runPromise(
        (path === "bring-up"
          ? bringUp(aliased, { api: fake.api, ctx })
          : bringDown({ ...aliased, services: {} }, { api: fake.api, ctx })
        ).pipe(Effect.result),
      );
      // Then neither path can delete the aliased network.
      expect(Result.isFailure(result)).toBe(true);
      expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    },
  );
}

test("bring-down mutates verified native IDs rather than reusable names", async () => {
  // Given
  const fake = fakeApi(
    new Map([
      ["/containers/lando-owned-web/json", { Id: "observed-container", Config: { Labels: ownedLabels } }],
      ["/networks/private", { Id: "observed-network", Labels: networkLabels }],
    ]),
  );
  // When
  await Effect.runPromise(bringDown(plan, { api: fake.api, ctx }));
  // Then
  expect(
    fake.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`),
  ).toEqual([
    "POST /containers/observed-container/stop",
    "DELETE /containers/observed-container?force=true&v=true",
    "DELETE /networks/observed-network",
  ]);
});

test("bring-down treats missing native objects as already absent", async () => {
  // Given
  const fake = fakeApi(new Map());
  // When
  const result = await Effect.runPromise(bringDown(plan, { api: fake.api, ctx }));
  // Then
  expect(result.changed).toBe(false);
  expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
});

for (const name of ["shared", "lando_bridge_network"]) {
  test(`bring-down never deletes shared network ${name} disguised as private`, async () => {
    // Given
    const fake = fakeApi(new Map([[`/networks/${name}`, { Id: "shared-id", Labels: networkLabels }]]));
    const disguised: AppPlan = {
      ...plan,
      services: {},
      networking: {
        ...plan.networking,
        perAppBridge: { name, driver: "bridge" },
        sharedNetworkMembership: { name: "shared", aliases: {} },
      },
    };
    // When
    await Effect.runPromise(bringDown(disguised, { api: fake.api, ctx }));
    // Then
    expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });

  test(`bring-up never labels or deletes shared network ${name} disguised as private`, async () => {
    // Given
    const calls: EngineHttpRequest[] = [];
    const disguised: AppPlan = {
      ...plan,
      networking: {
        perAppBridge: { name, driver: "bridge" },
        sharedNetworkMembership: { name: "shared", aliases: {} },
      },
    };
    const api: EngineHttpApi = {
      request: (request) =>
        Effect.sync(() => {
          calls.push(request);
          if (request.path === "/networks/create") return { status: 201, body: "{}" };
          if (request.path === "/containers/lando-owned-web/json")
            return { status: 200, body: JSON.stringify({ Id: "foreign", Config: { Labels: {} } }) };
          return { status: 404, body: "" };
        }),
    };
    // When
    const result = await Effect.runPromise(bringUp(disguised, { api, ctx }).pipe(Effect.result));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(
      calls
        .filter((call) => call.path === "/networks/create")
        .every((call) => typeof call.body === "object" && call.body !== null && !("Labels" in call.body)),
    ).toBe(true);
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });
}

test("bring-down refuses an owned container without observed native identity", async () => {
  // Given
  const fake = fakeApi(new Map([["/containers/lando-owned-web/json", { Config: { Labels: ownedLabels } }]]));
  // When
  const result = await Effect.runPromise(bringDown(plan, { api: fake.api, ctx }).pipe(Effect.result));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
});
