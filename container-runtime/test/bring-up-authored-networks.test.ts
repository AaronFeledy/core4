import { expect, test } from "bun:test";
import { type AppPlan, type ListenerAuthority, ServiceName } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { dockerLifecycleDialect, libpodLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpRequest } from "../src/engine-api.ts";
import { networkOwnershipLabels } from "../src/native-ownership.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { APPLY_REMEDIATION, bringUp } from "../src/podman/bring-up.ts";
import { field, networkApi, networkPlan } from "./authored-network-fixture.ts";

const ctx = { providerId: "docker", remediation: "Retry.", env: {} };
test("omits listener advice on network-connect failure", async () => {
  // Given
  const fake = networkApi({ connectStatus: 500 });
  const plan = {
    ...networkPlan,
    services: Object.fromEntries(
      Object.entries(networkPlan.services).map(([name, service]) => [
        name,
        {
          ...service,
          listenerAuthority: {
            owner: "launcher",
            daemon: "node",
            port: 3000,
            setting: "--port 3000",
          } satisfies ListenerAuthority,
        },
      ]),
    ),
  };
  // When
  const result = await Effect.runPromise(
    bringUp(plan, { api: fake.api, ctx, dialect: dockerLifecycleDialect }).pipe(Effect.result),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ServiceStartError",
      operation: "bringUp.network.connect",
      remediation: APPLY_REMEDIATION,
    },
  });
});
const endpoints = {
  "lando-networks": { Aliases: ["web", "frontend"] },
  lando_bridge_network: { Aliases: ["web.networks.internal"] },
  "lando-networks_private": { Aliases: ["web.networks.internal", "private-web"] },
  "sibling net": { Aliases: ["web.networks.internal", "public-web"] },
};
const scratchPlan: AppPlan = {
  ...networkPlan,
  extensions: { "@lando/core/scratch": { id: networkPlan.id } },
};

test.each([libpodLifecycleDialect, dockerLifecycleDialect])(
  "$engine creates scratch bridge and authored networks with complete proof, then removes observed IDs",
  async (dialect) => {
    const privateNames = ["lando-networks", "lando-networks_private"];
    const fake = networkApi({
      inspect: (name) => (privateNames.includes(name) ? { status: 404, body: "" } : undefined),
    });
    await Effect.runPromise(bringUp(scratchPlan, { api: fake.api, ctx, dialect }));
    const creates = fake.requests.filter(
      (request) =>
        request.method === "POST" && ["/networks/create", "/libpod/networks/create"].includes(request.path),
    );
    expect(creates).toHaveLength(2);
    const labels = networkOwnershipLabels(scratchPlan);
    for (const create of creates) {
      const body = create.body as Record<string, unknown>;
      expect(body.Labels ?? body.labels).toEqual(labels);
    }
    const removals: EngineHttpRequest[] = [];
    const api = {
      request: (request: EngineHttpRequest) =>
        Effect.sync(() => {
          removals.push(request);
          if (request.method === "GET" && request.path.startsWith("/networks/")) {
            const name = decodeURIComponent(request.path.slice("/networks/".length));
            return privateNames.includes(name)
              ? { status: 200, body: JSON.stringify({ Id: `id-${name}`, Name: name, Labels: labels }) }
              : { status: 404, body: "" };
          }
          return { status: request.method === "GET" ? 404 : 204, body: "" };
        }),
    };
    await Effect.runPromise(bringDown(scratchPlan, { api, ctx }));
    expect(
      removals.filter((request) => request.method === "DELETE" && request.path.startsWith("/networks/")),
    ).toEqual(privateNames.map((name) => ({ method: "DELETE", path: `/networks/id-${name}` })));
  },
);

test.each([libpodLifecycleDialect, dockerLifecycleDialect])(
  "$engine reuses only complete scratch bridge and authored proof",
  async (dialect) => {
    const labels = networkOwnershipLabels(scratchPlan);
    const fake = networkApi({
      inspect: (name) =>
        name === "lando-networks" || name === "lando-networks_private"
          ? {
              status: 200,
              body: JSON.stringify({
                Id: `id-${name}`,
                Name: name,
                Driver: name === "lando-networks_private" ? "macvlan" : "bridge",
                Labels: labels,
              }),
            }
          : undefined,
    });
    await Effect.runPromise(bringUp(scratchPlan, { api: fake.api, ctx, dialect }));
    expect(fake.requests.filter((request) => request.path.endsWith("/networks/create"))).toEqual([]);
  },
);

test.each([false, true])(
  "bringUp rejects unowned private bridge before container mutation (scratch=%s)",
  async (scratch) => {
    const selected = scratch ? scratchPlan : networkPlan;
    const fake = networkApi({
      inspect: (name) =>
        name === "lando-networks"
          ? {
              status: 200,
              body: JSON.stringify({ Id: "foreign-bridge", Name: name, Driver: "bridge", Labels: {} }),
            }
          : undefined,
    });
    const result = await Effect.runPromise(bringUp(selected, { api: fake.api, ctx }).pipe(Effect.result));
    expect(Result.isFailure(result)).toBe(true);
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
    expect(fake.requests.filter((request) => request.path.startsWith("/networks/"))).toEqual([
      { method: "GET", path: "/networks/sibling%20net" },
      { method: "GET", path: "/networks/lando-networks" },
    ]);
  },
);

test.each([false, true])("bringUp rechecks a racing private bridge once (scratch=%s)", async (scratch) => {
  const selected = scratch ? scratchPlan : networkPlan;
  const labels = networkOwnershipLabels(selected);
  let bridgeInspections = 0;
  const fake = networkApi({
    conflict: true,
    inspect: (name) => {
      if (name === "lando-networks")
        return bridgeInspections++ === 0
          ? { status: 404, body: "" }
          : {
              status: 200,
              body: JSON.stringify({ Id: "raced-bridge", Name: name, Driver: "bridge", Labels: labels }),
            };
      if (name === "lando-networks_private")
        return {
          status: 200,
          body: JSON.stringify({ Id: "authored-id", Name: name, Driver: "macvlan", Labels: labels }),
        };
      return undefined;
    },
  });
  await Effect.runPromise(bringUp(selected, { api: fake.api, ctx }));
  expect(bridgeInspections).toBe(2);
  expect(fake.requests.filter((request) => request.path === "/libpod/networks/create")).toHaveLength(1);
});

test.each([
  ["lando-networks", "old-four"],
  ["lando-networks", "empty"],
  ["lando-networks", "wrong-id"],
  ["lando-networks_private", "old-four"],
  ["lando-networks_private", "empty"],
  ["lando-networks_private", "wrong-id"],
] as const)("scratch bringDown refuses %s with %s proof", async (target, damage) => {
  const labels = networkOwnershipLabels(scratchPlan);
  const observedLabels =
    damage === "old-four"
      ? networkOwnershipLabels(networkPlan)
      : damage === "empty"
        ? {}
        : { ...labels, "dev.lando.scratch-id": "other" };
  const requests: EngineHttpRequest[] = [];
  const api = {
    request: (request: EngineHttpRequest) =>
      Effect.sync(() => {
        requests.push(request);
        if (request.method === "GET" && request.path === `/networks/${target}`)
          return {
            status: 200,
            body: JSON.stringify({ Id: "unproven-id", Name: target, Labels: observedLabels }),
          };
        return { status: request.method === "GET" ? 404 : 204, body: "" };
      }),
  };
  const result = await Effect.runPromise(bringDown(scratchPlan, { api, ctx }).pipe(Effect.result));
  expect(Result.isFailure(result)).toBe(true);
  expect(
    requests.some((request) => request.method === "DELETE" && request.path.startsWith("/networks/")),
  ).toBe(false);
});

test("leaves existing app bridges untouched", async () => {
  // Given
  const fake = networkApi();
  // When
  await Effect.runPromise(bringUp(networkPlan, { api: fake.api, ctx, dialect: libpodLifecycleDialect }));
  // Then
  expect(fake.requests.filter(({ path }) => path.endsWith("/networks/create"))).toEqual([]);
});

test("narrowed apply skips networks joined only by unselected services", async () => {
  // Given
  const plan = {
    ...networkPlan,
    services: Object.fromEntries(Object.entries(networkPlan.services).filter(([name]) => name === "worker")),
  };
  const fake = networkApi({ inspect: () => ({ status: 404, body: "{}" }) });
  // When
  await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
  // Then
  expect(fake.requests.filter((request) => /\/(?:libpod\/)?networks\//u.test(request.path))).toEqual([
    { method: "GET", path: "/networks/lando-networks" },
    {
      method: "POST",
      path: "/libpod/networks/create",
      body: {
        name: "lando-networks",
        driver: "bridge",
        dns_enabled: true,
        options: { metric: "50" },
        labels: networkOwnershipLabels(plan),
      },
    },
    { method: "GET", path: "/networks/lando_bridge_network" },
    { method: "POST", path: "/networks/create", body: { Name: "lando_bridge_network", Driver: "bridge" } },
  ]);
});

test.each([libpodLifecycleDialect, dockerLifecycleDialect])(
  "$engine attaches only service members with aliases",
  async (dialect) => {
    // Given
    const fake = networkApi();
    // When
    await Effect.runPromise(bringUp(networkPlan, { api: fake.api, ctx, dialect }));
    // Then
    const creates = fake.requests.filter((request) => request.path.startsWith("/containers/create?"));
    expect(field(field(creates[0]?.body, "NetworkingConfig"), "EndpointsConfig")).toEqual(
      dialect.engine === "docker"
        ? { "lando-networks": { ...endpoints["lando-networks"], GwPriority: 1 } }
        : endpoints,
    );
    expect(field(field(creates[1]?.body, "NetworkingConfig"), "EndpointsConfig")).toEqual({
      "lando-networks": { Aliases: ["worker"], ...(dialect.engine === "docker" ? { GwPriority: 1 } : {}) },
      ...(dialect.engine === "docker"
        ? {}
        : { lando_bridge_network: { Aliases: ["worker.networks.internal"] } }),
    });
    expect(fake.requests.filter((request) => request.path.endsWith("/connect"))).toEqual(
      dialect.engine === "docker"
        ? [
            ...Object.entries(endpoints)
              .slice(1)
              .map(
                ([name, endpoint]): EngineHttpRequest => ({
                  method: "POST",
                  path: `/networks/${encodeURIComponent(name)}/connect`,
                  body: { Container: "lando-networks-web", EndpointConfig: endpoint },
                }),
              ),
            {
              method: "POST",
              path: "/networks/lando_bridge_network/connect",
              body: {
                Container: "lando-networks-worker",
                EndpointConfig: { Aliases: ["worker.networks.internal"] },
              },
            },
          ]
        : [],
    );
  },
);

test.each([403, 409])(
  "reconnects every remaining attachment for existing Docker containers (HTTP %s)",
  async (connectStatus) => {
    // Given
    const fake = networkApi({ existing: true, connectStatus });
    // When
    await Effect.runPromise(bringUp(networkPlan, { api: fake.api, ctx, dialect: dockerLifecycleDialect }));
    // Then
    expect(fake.requests.filter((request) => request.path.endsWith("/connect"))).toHaveLength(4);
    expect(fake.requests.some((request) => request.path.startsWith("/containers/create"))).toBe(false);
  },
);

test.each([
  { status: 404, body: "{}" },
  { status: 500, body: "{}" },
  { status: 200, body: '{"Name":"prefix-matched-other-network"}' },
])("fails external preflight before any environment resolution or mutation: %j", async (response) => {
  // Given
  const fake = networkApi({ inspect: (name) => (name === "sibling net" ? response : undefined) });
  let resolutions = 0;
  // When
  const result = await Effect.runPromise(
    bringUp(networkPlan, {
      api: fake.api,
      ctx,
      resolveServiceEnvironment: () =>
        Effect.sync(() => {
          resolutions++;
          return {};
        }),
    }).pipe(Effect.result),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "ProviderUnavailableError",
      operation: "bringUp.network.external",
      message: expect.stringContaining("sibling net"),
      remediation: expect.stringContaining("lando start"),
    });
  expect(resolutions).toBe(0);
  expect(fake.requests).toEqual([{ method: "GET", path: "/networks/sibling%20net" }]);
});

test.each([
  { observed: { Name: "sibling net", Id: null }, allowed: true },
  { observed: { Name: "sibling net", ID: 123 }, allowed: true },
  { observed: { Name: "different-name", Id: null }, allowed: false },
])(
  "external preflight ignores opaque native IDs but requires exact name: %j",
  async ({ observed, allowed }) => {
    const fake = networkApi({
      inspect: (name) =>
        name === "sibling net" ? { status: 200, body: JSON.stringify(observed) } : undefined,
    });
    const result = await Effect.runPromise(bringUp(networkPlan, { api: fake.api, ctx }).pipe(Effect.result));
    expect(Result.isSuccess(result)).toBe(allowed);
    if (!allowed) expect(fake.requests).toEqual([{ method: "GET", path: "/networks/sibling%20net" }]);
  },
);

test("creates a missing owned network with planned driver and ownership labels, never creates external", async () => {
  // Given
  const fake = networkApi({
    inspect: (name) => (name === "lando-networks_private" ? { status: 404, body: "{}" } : undefined),
  });
  // When
  await Effect.runPromise(bringUp(networkPlan, { api: fake.api, ctx }));
  // Then
  expect(
    fake.requests.filter((request) => request.path === "/networks/create").map((request) => request.body),
  ).toEqual([
    { Name: "lando-networks_private", Driver: "macvlan", Labels: networkOwnershipLabels(networkPlan) },
  ]);
  expect(fake.requests.some((request) => request.method === "DELETE")).toBe(false);
});

test.each([
  {
    Id: "conflicting-authored",
    Name: "lando-networks_private",
    Driver: "macvlan",
    Labels: { foreign: "owner" },
    remediation: "set `external: true` and `name: lando-networks_private` under networks.private",
  },
  {
    Id: "conflicting-authored",
    Name: "lando-networks_private",
    Driver: "macvlan",
    Labels: {},
    remediation: "Remove or rename",
  },
  {
    Id: "conflicting-authored",
    Name: "lando-networks_private",
    Driver: "bridge",
    Labels: networkOwnershipLabels(networkPlan),
    remediation: "lando destroy",
  },
  {
    Id: "conflicting-authored",
    Name: "different-name",
    Driver: "macvlan",
    Labels: networkOwnershipLabels(networkPlan),
    remediation: "conflict",
  },
])("rejects conflicting owned network %j", async ({ remediation, ...body }) => {
  // Given
  const fake = networkApi({
    inspect: (name) =>
      name === "lando-networks_private" ? { status: 200, body: JSON.stringify(body) } : undefined,
  });
  // When
  const result = await Effect.runPromise(bringUp(networkPlan, { api: fake.api, ctx }).pipe(Effect.result));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "ProviderUnavailableError",
      remediation: expect.stringContaining(remediation),
    });
  expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
});

test.each([false, true])("verifies ownership again after a create conflict (foreign=%s)", async (foreign) => {
  // Given
  let inspections = 0;
  const fake = networkApi({
    conflict: true,
    inspect: (name) => {
      if (name !== "lando-networks_private") return undefined;
      if (inspections++ === 0) return { status: 404, body: "{}" };
      return {
        status: 200,
        body: JSON.stringify({
          Id: "raced-authored-network",
          Name: name,
          Driver: "macvlan",
          Labels: foreign ? {} : networkOwnershipLabels(networkPlan),
        }),
      };
    },
  });
  // When
  const result = await Effect.runPromise(bringUp(networkPlan, { api: fake.api, ctx }).pipe(Effect.result));
  // Then
  expect(Result.isFailure(result)).toBe(foreign);
  expect(inspections).toBe(2);
});

test("reconnects all after-create attachments after a host-port retry", async () => {
  // Given
  const web = networkPlan.services[ServiceName.make("web")];
  if (web === undefined) throw new TypeError("Missing web fixture");
  const plan: AppPlan = {
    ...networkPlan,
    services: {
      [web.name]: {
        ...web,
        endpoints: [
          {
            _tag: "published" as const,
            port: 80,
            protocol: "http",
            publication: { bindAddress: "127.0.0.1" },
          },
        ],
      },
    },
  };
  const fake = networkApi({ retryStart: true });
  // When
  await Effect.runPromise(
    bringUp(plan, {
      api: fake.api,
      ctx,
      dialect: dockerLifecycleDialect,
      platform: "linux",
      probeBind: () => Effect.succeed({ kind: "success" }),
    }),
  );
  // Then
  expect(fake.requests.filter((request) => request.path.startsWith("/containers/create?"))).toHaveLength(2);
  expect(fake.requests.filter((request) => request.path.endsWith("/connect"))).toHaveLength(6);
});
