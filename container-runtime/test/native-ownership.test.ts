import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
  planAppIdentity,
} from "@lando/sdk/schema";
import { DateTime, Effect, Result } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import {
  coherentContainerOwnership,
  containerOwnershipLabels,
  inspectOwnedNativeId,
  privateNetworkLabels as ownershipPrivateNetworkLabels,
  ownsServiceContainer,
  serviceContainerOwnershipLabels,
  verifiedNativeId,
} from "../src/native-ownership.ts";
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
  stores: [],
  routes: [],
  fileSync: [],
  extensions: {},
  metadata,
};
const service = plan.services[web];
if (service === undefined) throw new TypeError("Missing fixture service");
const ownedLabels = commonContainerLabels(plan, service);
const globalPlan: AppPlan = {
  ...plan,
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root: AbsolutePath.make("/home/me/.lando/global"),
  provider: ProviderId.make("lando"),
};
const scratchPlan: AppPlan = {
  ...plan,
  id: AppId.make("scratch-demo"),
  name: "scratch-demo",
  slug: "scratch-demo",
  root: AbsolutePath.make("/tmp/scratch-demo"),
  extensions: { "@lando/core/scratch": { id: "scratch-demo" } },
};

test.each([
  { name: "native ownership", labels: ownedLabels, containerId: "owned-id", service: "web", owned: true },
  { name: "absent labels", labels: {}, containerId: "owned-id", service: "web", owned: false },
  {
    name: "role helper",
    labels: { ...ownedLabels, "dev.lando.role": "helper" },
    containerId: "owned-id",
    service: "web",
    owned: false,
  },
  {
    name: "foreign root",
    labels: { ...ownedLabels, "dev.lando.app-root": "/other" },
    containerId: "owned-id",
    service: "web",
    owned: false,
  },
  {
    name: "foreign provider",
    labels: { ...ownedLabels, "dev.lando.provider": "lando" },
    containerId: "owned-id",
    service: "web",
    owned: false,
  },
  {
    name: "foreign owner",
    labels: { ...ownedLabels, "dev.lando.owner": "other" },
    containerId: "owned-id",
    service: "web",
    owned: false,
  },
  {
    name: "scratch labels",
    labels: { ...ownedLabels, "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": plan.id },
    containerId: "owned-id",
    service: "web",
    owned: false,
  },
  {
    name: "different observed service",
    labels: ownedLabels,
    containerId: "owned-id",
    service: "other",
    owned: false,
  },
  { name: "absent identity", labels: ownedLabels, containerId: "", service: "web", owned: false },
])("service-container mutation requires $name proof", (row) => {
  expect(ownsServiceContainer(plan, row)).toBe(row.owned);
});

const ownershipIdentity = {
  app: "owned",
  appRoot: "/owned",
  service: "web",
  providerId: "docker",
} as const;

test.each([
  { name: "legitimate native labels", labels: ownedLabels, accepted: true },
  {
    name: "a matching provider label",
    labels: { ...ownedLabels, "dev.lando.provider": "docker" },
    accepted: true,
  },
  {
    name: "a matching owner label",
    labels: { ...ownedLabels, "dev.lando.owner": appIdentityKey("owner", "/owned") },
    accepted: true,
  },
  { name: "a matching legacy label", labels: { ...ownedLabels, "com.lando.app": "owned" }, accepted: true },
  {
    name: "scratch markers on the app's own scratch id",
    labels: { ...ownedLabels, "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": "owned" },
    accepted: true,
  },
  { name: "a foreign app", labels: { ...ownedLabels, "dev.lando.app": "other" }, accepted: false },
  { name: "a foreign root", labels: { ...ownedLabels, "dev.lando.app-root": "/other" }, accepted: false },
  { name: "a foreign service", labels: { ...ownedLabels, "dev.lando.service": "other" }, accepted: false },
  {
    name: "a missing service label",
    labels: { "dev.lando.app": "owned", "dev.lando.app-root": "/owned" },
    accepted: false,
  },
  {
    name: "a conflicting provider",
    labels: { ...ownedLabels, "dev.lando.provider": "lando" },
    accepted: false,
  },
  { name: "a conflicting owner", labels: { ...ownedLabels, "dev.lando.owner": "other" }, accepted: false },
  { name: "a role helper", labels: { ...ownedLabels, "dev.lando.role": "data-helper" }, accepted: false },
  {
    name: "a contradictory legacy label",
    labels: { ...ownedLabels, "com.lando.app": "other" },
    accepted: false,
  },
  {
    name: "an incoherent scratch marker",
    labels: { ...ownedLabels, "dev.lando.scratch": "TRUE" },
    accepted: false,
  },
  {
    name: "a foreign scratch id",
    labels: { ...ownedLabels, "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": "other" },
    accepted: false,
  },
])("the shared ownership predicate accepts $name=$accepted", ({ labels, accepted }) => {
  expect(serviceContainerOwnershipLabels(labels, ownershipIdentity)).toBe(accepted);
});

test("the shared ownership predicate refuses an absent label set", () => {
  expect(serviceContainerOwnershipLabels(undefined, ownershipIdentity)).toBe(false);
});

test("legitimate global and scratch service containers pass the shared predicate", () => {
  const globalService = globalPlan.services[web];
  const scratchService = scratchPlan.services[web];
  if (globalService === undefined || scratchService === undefined)
    throw new TypeError("Missing fixture service");

  expect(
    serviceContainerOwnershipLabels(commonContainerLabels(globalPlan, globalService), {
      app: "global",
      appRoot: "/home/me/.lando/global",
      service: "web",
      providerId: "lando",
    }),
  ).toBe(true);
  expect(
    ownsServiceContainer(globalPlan, {
      containerId: "global-id",
      service: "web",
      labels: commonContainerLabels(globalPlan, globalService),
    }),
  ).toBe(true);

  const scratchLabels = commonContainerLabels(scratchPlan, scratchService);
  expect(scratchLabels["dev.lando.scratch"]).toBe("TRUE");
  expect(
    serviceContainerOwnershipLabels(scratchLabels, {
      app: "scratch-demo",
      appRoot: "/tmp/scratch-demo",
      service: "web",
      providerId: "docker",
    }),
  ).toBe(true);
  expect(
    ownsServiceContainer(scratchPlan, {
      containerId: "scratch-id",
      service: "web",
      labels: scratchLabels,
    }),
  ).toBe(true);
});

test("legacy com.lando.app handling stays as it was", () => {
  expect(coherentContainerOwnership({ "com.lando.app": "owned" }, "docker")).toBe(true);
  expect(
    coherentContainerOwnership({ "com.lando.app": "owned", "dev.lando.provider": "docker" }, "docker"),
  ).toBe(false);
  expect(coherentContainerOwnership({ ...ownedLabels, "dev.lando.provider": "lando" }, "docker")).toBe(false);
});
const networkLabels = privateNetworkLabels({
  ...planAppIdentity(plan),
  appId: plan.id,
  providerId: plan.provider,
});
const ctx = { providerId: "docker", remediation: "retry", env: {} };

const fakeApi = (observations: ReadonlyMap<string, object>) => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        calls.push(request);
        if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
          return { status: 200, body: "[]" };
        }
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
      ["/containers/lando-owned--web/json", { Id: "original", Config: { Labels: ownedLabels } }],
    ]);
    observations.set("/containers/lando-owned--web/json", { Id: "replacement", Config: { Labels: labels } });
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
          "/containers/lando-owned--web/json",
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
      ["/containers/lando-owned--web/json", { Id: "foreign", Config: { Labels: {} } }],
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
          ["/containers/lando-owned--web/json", { Id: "foreign", Config: { Labels: {} } }],
        ]),
      );
      // When bring-up fails closed or bring-down validates ownership.
      const result = await Effect.runPromise(
        (path === "bring-up"
          ? bringUp(aliased, { api: fake.api, ctx }).pipe(Effect.asVoid)
          : bringDown({ ...aliased, services: {} }, { api: fake.api, ctx }).pipe(Effect.asVoid)
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
      ["/containers/lando-owned--web/json", { Id: "observed-container", Config: { Labels: ownedLabels } }],
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
          if (request.path.startsWith("/containers/json?")) return { status: 200, body: "[]" };
          if (request.path === "/networks/create") return { status: 201, body: "{}" };
          if (request.path === "/containers/lando-owned--web/json")
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
  const fake = fakeApi(new Map([["/containers/lando-owned--web/json", { Config: { Labels: ownedLabels } }]]));
  // When
  const result = await Effect.runPromise(bringDown(plan, { api: fake.api, ctx }).pipe(Effect.result));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
});

test("verifiedNativeId names a coherent foreign-root container and keeps machine fields", async () => {
  // Given: a planned name held by another Lando app's coherent ownership labels.
  const foreignRoot = "/home/me/shop";
  const name = "lando-owned--web";
  const labels = {
    ...containerOwnershipLabels(plan, web),
    "dev.lando.app-root": foreignRoot,
    "dev.lando.app": "other-app",
  };
  // When
  const result = await Effect.runPromise(
    verifiedNativeId(
      JSON.stringify({ Id: "foreign-id", Name: `/${name}`, Config: { Labels: labels } }),
      containerOwnershipLabels(plan, web),
      ctx,
      { kind: "container", name },
    ).pipe(Effect.result),
  );
  // Then: same error class/operation; message names resource and other root; details carry root.
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderUnavailableError",
      providerId: "docker",
      operation: "resource-ownership",
      message: `Container ${name} already belongs to the Lando app at ${foreignRoot}. Two apps can't use the same name.`,
      remediation:
        "Change `name:` in this app's .lando.yml (or destroy the other app) and run `lando start` again.",
      details: { root: foreignRoot },
    },
  });
});

test("verifiedNativeId refuses unlabeled or incoherent resources and names the failing label", async () => {
  // Given: unlabeled and incoherent label sets at the planned name.
  for (const [labels, problem] of [
    [{}, "dev.lando.app label"],
    [{ "dev.lando.app": "x" }, "dev.lando.app label"],
    [
      { ...containerOwnershipLabels(plan, web), "dev.lando.app-root": "/other/app", "dev.lando.service": "" },
      "dev.lando.app-root label",
    ],
  ] as const) {
    // When
    const result = await Effect.runPromise(
      verifiedNativeId(
        JSON.stringify({ Id: "unknown-id", Name: "lando-owned-web", Config: { Labels: labels } }),
        containerOwnershipLabels(plan, web),
        ctx,
        { kind: "container", name: "lando-owned-web" },
      ).pipe(Effect.result),
    );
    // Then: a verification refusal naming the container and failing label, not the foreign-root remediation.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ProviderUnavailableError",
        operation: "resource-ownership",
        details: { container: "lando-owned-web", problem },
      },
    });
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        remediation:
          "Inspect the conflicting native resource and restore its verified Lando ownership or move it out of the planned name before retrying. Unlabeled resources cannot be adopted.",
      });
    }
  }
});

for (const labels of [
  { ...containerOwnershipLabels(plan, web), "dev.lando.provider": "lando" },
  { ...containerOwnershipLabels(plan, web), "dev.lando.owner": "other-owner" },
  { ...containerOwnershipLabels(plan, web), "dev.lando.role": "data-helper" },
  { ...containerOwnershipLabels(plan, web), "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": "owned" },
]) {
  test(`inspectOwnedNativeId refuses planned-name container ownership ${JSON.stringify(labels)}`, async () => {
    // Given
    const name = "lando-owned--web";
    const fake = fakeApi(
      new Map([[`/containers/${name}/json`, { Id: "replacement", Config: { Labels: labels } }]]),
    );
    // When
    const result = await Effect.runPromise(
      inspectOwnedNativeId(
        fake.api,
        { kind: "container", name, labels: containerOwnershipLabels(plan, web) },
        ctx,
      ).pipe(Effect.result),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUnavailableError", operation: "resource-ownership" },
    });
    expect(fake.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
}

test("inspectOwnedNativeId accepts a scratch plan's own container", async () => {
  // Given
  const name = "lando-scratch-demo--web";
  const scratchService = scratchPlan.services[web];
  if (scratchService === undefined) throw new TypeError("Missing scratch fixture service");
  const fake = fakeApi(
    new Map([
      [
        `/containers/${name}/json`,
        { Id: "scratch-container", Config: { Labels: commonContainerLabels(scratchPlan, scratchService) } },
      ],
    ]),
  );
  // When
  const id = await Effect.runPromise(
    inspectOwnedNativeId(
      fake.api,
      { kind: "container", name, labels: containerOwnershipLabels(scratchPlan, web) },
      ctx,
    ),
  );
  // Then
  expect(id).toBe("scratch-container");
});

test("inspectOwnedNativeId names a coherent foreign-root network", async () => {
  // Given: another app's coherent private-network ownership at the planned name.
  const foreignRoot = AbsolutePath.make("/other/app");
  const foreign = ownershipPrivateNetworkLabels({
    appId: AppId.make("other"),
    appRoot: foreignRoot,
    ownerKey: appIdentityKey("owner", foreignRoot),
    providerId: plan.provider,
  });
  const fake = fakeApi(new Map([["/networks/private", { Id: "net-id", Labels: foreign }]]));
  // When
  const result = await Effect.runPromise(
    inspectOwnedNativeId(
      fake.api,
      { kind: "network", name: "private", labels: networkLabels, legacy: "accept" },
      ctx,
    ).pipe(Effect.result),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderUnavailableError",
      operation: "resource-ownership",
      message: `Network private already belongs to the Lando app at ${foreignRoot}. Two apps can't use the same name.`,
      details: { root: foreignRoot },
    },
  });
});
