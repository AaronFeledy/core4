import { expect, test } from "bun:test";
import { join } from "node:path";
import { ProviderInternalError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Cause, DateTime, Effect, Exit, Option, Result, Schema } from "effect";
import { adoptLegacyDataRoot } from "../src/data-root-adoption.ts";
import type { EngineHttpApi } from "../src/engine-api.ts";
import { APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL } from "../src/labels.ts";
import { networkOwnershipLabels } from "../src/native-ownership.ts";
import { commonContainerLabels, serviceContainerName } from "../src/plan.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { makeOwnedResourcesCleanup } from "../src/resource-cleanup.ts";
import { ResourceOwnershipInventory, makeResourceOwnershipStore } from "../src/resource-ownership.ts";
import { resourcesForPlan } from "../src/resource-ownership-inventory.ts";
import { volumeOwnershipLabels } from "../src/volume-ownership.ts";
import { bringUp } from "./support/service-creation.ts";

const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("creation"),
  name: "creation",
  slug: "creation",
  root: AbsolutePath.make("/owner"),
  provider: ProviderId.make("podman"),
  identity: { appRoot: AbsolutePath.make("/owner"), ownerKey: appIdentityKey("owner", "/owner") },
  services: {},
  routes: [],
  stores: [{ name: "data", scope: "app", kind: "data" }],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
};
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "nginx",
  provider: plan.provider,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:alpine" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: plan.metadata,
  extensions: {},
};
const Request = Schema.Struct({
  Name: Schema.String,
  Labels: Schema.Record(Schema.String, Schema.String),
});

test.each([false, true])(
  "scoped apply preserves an old named volume only with a verified receipt (%s)",
  async (recorded) => {
    const store = { name: "data", scope: "app", kind: "data" } as const;
    const old = { ...plan, stores: [store] };
    const desired = {
      ...old,
      identity: {
        appRoot: plan.root,
        ownerKey: appIdentityKey("owner", plan.root),
        dataRoot: AbsolutePath.make("/local-data"),
      },
    };
    const volume = {
      Name: store.name,
      Labels: {
        ...volumeOwnershipLabels(old, store),
        "dev.lando.app": plan.id,
        "dev.lando.scope": "app",
        "dev.lando.store": store.name,
        "dev.lando.volume-instance": "populated",
      },
    };
    const result = await Effect.runPromise(
      bringUp(desired, {
        adoptionReceipts: recorded
          ? [
              {
                kind: "volume",
                nativeName: store.name,
                volumeInstance: "populated",
                appId: old.id,
                appRoot: old.root,
                providerId: old.provider,
                dataRoot: desired.identity.dataRoot,
              },
            ]
          : [],
        ctx: { providerId: "podman", remediation: "test", env: {} },
        api: {
          request: ({ method, path }) => {
            if (method === "DELETE") return Effect.die("Existing data must never be deleted to claim it");
            if (path === "/volumes/create") return Effect.succeed({ status: 409, body: "{}" });
            if (path === "/volumes/data")
              return Effect.succeed({ status: 200, body: JSON.stringify(volume) });
            return Effect.succeed({ status: 200, body: "[]" });
          },
        },
      }).pipe(Effect.result),
    );
    if (recorded) expect(result).toMatchObject({ _tag: "Success", success: { createdVolumes: [] } });
    else
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { operation: "bringUp.volume", remediation: expect.stringMatching(/different app name/i) },
      });
  },
);

test("v1 inventory upgrades and destroys the legacy app without touching peer-root resources", async () => {
  const store = { name: "data", scope: "app", kind: "data" } as const;
  const stores = [store, ...["node-modules", "tmp", "vendor"].map((name) => ({ ...store, name }))];
  const dataRoot = AbsolutePath.make("/local-data");
  const networking = { perAppBridge: { name: "lando-creation", driver: "bridge" as const } };
  const old: AppPlan = {
    ...plan,
    networking,
    stores,
    services: {
      [service.name]: {
        ...service,
        mounts: [{ type: "volume", store: store.name, target: PortablePath.make("/data"), readOnly: false }],
      },
    },
  };
  const desired: AppPlan = {
    ...old,
    identity: {
      appRoot: plan.root,
      ownerKey: appIdentityKey("owner", plan.root),
      dataRoot,
    },
  };
  const container = serviceContainerName(old, service.name);
  const legacyLabels = {
    [APP_LABEL]: old.id,
    [APP_ROOT_LABEL]: old.root,
    [SERVICE_LABEL]: service.name,
  };
  const peerStore = { ...store, name: "peer-data" };
  const volumes = new Map(
    [...stores, peerStore].map((entry) => [
      entry.name,
      {
        ...volumeOwnershipLabels(old, entry),
        "dev.lando.app": old.id,
        "dev.lando.scope": "app",
        "dev.lando.store": entry.name,
        "dev.lando.volume-instance": `generation-${entry.name}`,
        ...(entry === peerStore ? { [LANDO_DATA_ROOT_LABEL]: "/peer-data-root" } : {}),
      },
    ]),
  );
  let containerExists = true;
  let running = true;
  let upgraded = false;
  let createdLabels: Readonly<Record<string, string>> | undefined;
  let mountedContents: string | undefined;
  const contents = new Map<string, string>([[store.name, "pre-upgrade database contents"]]);
  const networkName = networking.perAppBridge.name;
  const networks = new Map<
    string,
    { Id: string; Name: string; Driver: string; Labels: Record<string, string> }
  >([
    [
      networkName,
      { Id: "legacy-network", Name: networkName, Driver: "bridge", Labels: networkOwnershipLabels(old) },
    ],
    [
      "peer-network",
      {
        Id: "peer-network",
        Name: "peer-network",
        Driver: "bridge",
        Labels: { ...networkOwnershipLabels(old), [LANDO_DATA_ROOT_LABEL]: "/peer-data-root" },
      },
    ],
  ]);
  const deleted: string[] = [];
  const ctx = { providerId: "podman", remediation: "test", env: {} };
  const api = {
    request: ({ method, path, body }) =>
      Effect.sync(() => {
        if (method === "GET" && path.startsWith("/containers/json?")) return { status: 200, body: "[]" };
        const activeId = upgraded ? "fresh-id" : "legacy-id";
        if (
          method === "GET" &&
          (path === `/containers/${container}/json` || path === `/containers/${activeId}/json`)
        ) {
          if (!containerExists) return { status: 404, body: "{}" };
          return {
            status: 200,
            body: JSON.stringify({
              Id: activeId,
              Name: `/${container}`,
              State: { Running: running },
              Config: { Labels: upgraded ? createdLabels : legacyLabels },
              HostConfig: {},
              Mounts: [{ Type: "volume", Name: store.name, Destination: "/data" }],
            }),
          };
        }
        if (method === "POST" && path.startsWith(`/containers/${activeId}/stop`)) {
          running = false;
          return { status: 204, body: "" };
        }
        if (method === "DELETE" && path.startsWith(`/containers/${activeId}?`)) {
          deleted.push(path);
          containerExists = false;
          running = false;
          return { status: 204, body: "" };
        }
        if (method === "POST" && path.startsWith("/containers/create")) {
          const parsed = typeof body === "string" ? JSON.parse(body) : body;
          createdLabels = parsed?.Labels ?? parsed?.labels;
          const binds = Schema.decodeUnknownOption(Schema.Array(Schema.String))(parsed?.HostConfig?.Binds);
          const source = Option.getOrElse(binds, () => [])
            .find((bind) => bind.endsWith(":/data"))
            ?.split(":")[0];
          mountedContents = source === undefined ? undefined : contents.get(source);
          upgraded = true;
          containerExists = true;
          return { status: 201, body: JSON.stringify({ Id: "fresh-id" }) };
        }
        if (method === "POST" && path.endsWith("/start")) {
          running = true;
          return { status: 204, body: "" };
        }
        if (path === "/volumes/create") return { status: 409, body: "{}" };
        if (method === "GET" && path === "/volumes")
          return {
            status: 200,
            body: JSON.stringify({ Volumes: [...volumes].map(([Name, Labels]) => ({ Name, Labels })) }),
          };
        if (path.startsWith("/volumes/")) {
          const name = decodeURIComponent(path.slice("/volumes/".length).split("?")[0] ?? "");
          if (method === "DELETE") {
            deleted.push(path);
            return { status: volumes.delete(name) ? 204 : 404, body: "" };
          }
          const labels = volumes.get(name);
          return labels === undefined
            ? { status: 404, body: "{}" }
            : { status: 200, body: JSON.stringify({ Name: name, Labels: labels }) };
        }
        if (method === "DELETE" && path.startsWith("/networks/")) {
          deleted.push(path);
          const entry = [...networks].find(([, network]) => path === `/networks/${network.Id}`);
          return { status: entry !== undefined && networks.delete(entry[0]) ? 204 : 404, body: "" };
        }
        if (method === "GET" && path.startsWith("/networks/")) {
          const name = decodeURIComponent(path.slice("/networks/".length));
          const observed = networks.get(name);
          return observed === undefined
            ? { status: 404, body: "" }
            : { status: 200, body: JSON.stringify(observed) };
        }
        if (method === "POST" && (path === "/networks/create" || path === "/libpod/networks/create")) {
          const parsed = (typeof body === "string" ? JSON.parse(body) : body) as {
            Name?: string;
            name?: string;
            Labels?: Record<string, string>;
            labels?: Record<string, string>;
            Driver?: string;
            driver?: string;
          };
          const name = parsed.Name ?? parsed.name ?? "network";
          networks.set(name, {
            Id: `id-${name}`,
            Name: name,
            Driver: parsed.Driver ?? parsed.driver ?? "bridge",
            Labels: parsed.Labels ?? parsed.labels ?? {},
          });
          return { status: 201, body: "{}" };
        }
        if (method === "POST" && path.includes("/connect")) return { status: 200, body: "{}" };
        return { status: 200, body: "{}" };
      }),
  } satisfies EngineHttpApi;
  const state = makeTestStateStore();
  const access = { enforce: async () => undefined, verify: async () => undefined };
  const inventory = makeResourceOwnershipStore(
    old.provider,
    makePluginStateStore(state.service, dataRoot, access),
  );
  const { ownerKey } = desired.identity ?? {};
  const file = AbsolutePath.make(join(dataRoot, "resource-ownership", `${ownerKey}.json`));
  await Effect.runPromise(
    state.writeRaw(
      file,
      JSON.stringify({
        version: 1,
        data: {
          appRoot: old.root,
          ownerKey,
          providerId: old.provider,
          appIds: [old.id],
          resources: resourcesForPlan(old),
        },
      }),
    ),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      expect((yield* inventory.load(old.root))?.resources.every((row) => row.dataRoot === undefined)).toBe(
        true,
      );
      yield* adoptLegacyDataRoot(desired, old, { request: api.request, store: inventory });
      yield* inventory.prepare(desired, old);
      const adoptionReceipts =
        (yield* inventory.load(old.root))?.adoptions?.flatMap((batch) => batch.receipts) ?? [];
      return yield* bringUp(desired, { ctx, api, adoptionReceipts });
    }),
  );
  expect(result.createdVolumes).toEqual([]);
  expect(mountedContents).toBe("pre-upgrade database contents");
  expect(deleted.some((path) => path.includes("legacy-id"))).toBe(true);
  expect(createdLabels?.[LANDO_DATA_ROOT_LABEL]).toBe(dataRoot);
  expect(createdLabels?.[APP_LABEL]).toBe(desired.id);
  expect(createdLabels?.[APP_ROOT_LABEL]).toBe(desired.root);
  expect(createdLabels?.[SERVICE_LABEL]).toBe(service.name);
  // Legacy fingerprint is unlabeled; the replacement must carry a new create config.
  expect(createdLabels?.["dev.lando.create-config"]).toBeDefined();
  expect(createdLabels?.["dev.lando.create-config"]).not.toBe(
    commonContainerLabels(old, service)["dev.lando.create-config"],
  );
  expect([...volumes.keys()]).toEqual([...stores.map(({ name }) => name), peerStore.name]);
  const adopted = await Effect.runPromise(inventory.load(old.root));
  const receipt = await Effect.runPromise(
    bringDown(desired, {
      adoptionReceipts: adopted?.adoptions?.flatMap((batch) => batch.receipts) ?? [],
      ctx,
      api,
      volumes: true,
      endpointNamespace: "upgrade-fixture",
    }).pipe(Effect.provide(state.layer)),
  );
  expect(receipt.volumesRemoved).toEqual({ data: 4, cache: 0 });
  expect([...networks.keys()]).toEqual(["peer-network"]);
  expect([...volumes.keys()]).toEqual([peerStore.name]);
  expect(deleted.filter((path) => path.includes("peer"))).toEqual([]);
  expect(containerExists).toBe(false);
  const migrated = await Effect.runPromise(inventory.load(old.root));
  expect(
    migrated?.resources.map(({ nativeName, dataRoot: recorded }) => [nativeName, recorded]).sort(),
  ).toEqual(
    [container, networkName, ...stores.map(({ name }) => name)].map((name) => [name, dataRoot]).sort(),
  );
  expect(
    Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(3), data: ResourceOwnershipInventory })),
    )(new TextDecoder().decode((await Effect.runPromise(state.readRaw(file))) ?? undefined)).version,
  ).toBe(3);
  const cleanup = makeOwnedResourcesCleanup({
    ctx,
    api,
    store: inventory,
    userDataRoot: dataRoot,
    endpointNamespace: "upgrade-fixture",
  });
  await Effect.runPromise(cleanup(old.root, { volumes: true }).pipe(Effect.provide(state.layer)));
  // The adoption batch still records that this data root was checked, so the inventory stays.
  expect((await Effect.runPromise(inventory.load(old.root)))?.resources).toEqual([]);
});

test.each([false, true])(
  "Podman apply reports actual creation, not existing volume success (existing=%s)",
  async (existing) => {
    const receipts: string[] = [];
    const result = await Effect.runPromise(
      bringUp(plan, {
        ctx: { providerId: "podman", remediation: "test", env: {} },
        onVolumeCreated: (fact) =>
          Effect.sync(() => {
            receipts.push(fact.nativeName);
          }),
        api: {
          request: (request) => {
            if (request.method === "GET" && request.path.startsWith("/containers/json?"))
              return Effect.succeed({ status: 200, body: "[]" });
            if (request.path !== "/volumes/create") return Effect.succeed({ status: 200, body: "{}" });
            return Schema.decodeUnknownEffect(Request)(request.body).pipe(
              Effect.orDie,
              Effect.map((body) => ({
                status: 201,
                body: JSON.stringify({
                  ...body,
                  Labels: existing
                    ? { ...body.Labels, "dev.lando.volume-instance": "existing" }
                    : body.Labels,
                }),
              })),
            );
          },
        },
      }),
    );
    expect(result.createdVolumes).toHaveLength(existing ? 0 : 1);
    expect(receipts).toEqual(existing ? [] : ["data"]);
    if (!existing) expect(result.createdVolumes?.[0]?.ownerRoot).toBe(AbsolutePath.make("/owner"));
  },
);

test.each([false, true])(
  "creation receipts finish before services start (receipt fails=%s)",
  async (fails) => {
    const servicePlan: AppPlan = {
      ...plan,
      stores: [...plan.stores, { name: "cache", scope: "app", kind: "cache" }],
      services: { [service.name]: service },
    };
    const events: string[] = [];
    let running = false;
    const failure = new ProviderInternalError({
      providerId: "podman",
      operation: "receipt",
      message: "Persistence failed.",
      remediation:
        "Re-run the command after checking `podman` logs for the `receipt` failure; if it persists, report the error with that operation name.",
    });
    const result = await Effect.runPromise(
      Effect.result(
        bringUp(servicePlan, {
          ctx: { providerId: "podman", remediation: "test", env: {} },
          api: {
            request: (request) =>
              Effect.sync(() => {
                if (request.method === "GET" && request.path.startsWith("/containers/json?"))
                  return { status: 200, body: "[]" };
                if (request.path === "/volumes/create") {
                  const body = Schema.decodeUnknownSync(Request)(request.body);
                  events.push(`create:${body.Name}`);
                  return { status: 201, body: JSON.stringify(body) };
                }
                if (request.path.endsWith("/start")) {
                  events.push("start");
                  running = true;
                  return { status: 204, body: "" };
                }
                if (request.path.endsWith("/json"))
                  return running
                    ? { status: 200, body: '{"Id":"web","State":{"Running":true}}' }
                    : { status: 404, body: "{}" };
                if (request.method === "GET" && request.path.startsWith("/networks/"))
                  return { status: 404, body: "" };
                return { status: 201, body: "{}" };
              }),
          },
          onVolumeCreated: (fact) =>
            Effect.yieldNow.pipe(
              Effect.andThen(
                fails
                  ? Effect.fail(failure)
                  : Effect.sync(() => {
                      events.push(`receipt:${fact.nativeName}`);
                    }),
              ),
            ),
        }),
      ),
    );
    if (fails) {
      expect(Result.isFailure(result) && result.failure).toBe(failure);
      expect(events).toEqual(["create:data"]);
    } else {
      expect(Result.isSuccess(result)).toBe(true);
      expect(events).toEqual(["create:data", "receipt:data", "create:cache", "receipt:cache", "start"]);
    }
  },
);

test.each(["fails", "interrupts"] as const)(
  "a receipt that %s retains the networks and volume this apply created",
  async (outcome) => {
    // Given: an apply that creates its app network, then a volume whose receipt does not complete.
    const servicePlan: AppPlan = { ...plan, services: { [service.name]: service } };
    const deleted: string[] = [];
    const networks = new Map<string, object>();
    const volumes = new Map<string, typeof Request.Type>();
    const failure = new ProviderInternalError({
      providerId: "podman",
      operation: "receipt",
      message: "No receipt.",
      remediation:
        "Re-run the command after checking `podman` logs for the `receipt` failure; if it persists, report the error with that operation name.",
    });
    const exit = await Effect.runPromiseExit(
      bringUp(servicePlan, {
        ctx: { providerId: "podman", remediation: "test", env: {} },
        onVolumeCreated: () => (outcome === "fails" ? Effect.fail(failure) : Effect.interrupt),
        api: {
          request: (request) =>
            Effect.sync(() => {
              if (request.method === "GET" && request.path.startsWith("/containers/json?"))
                return { status: 200, body: "[]" };
              if (request.path === "/volumes/create") {
                const volume = Schema.decodeUnknownSync(Request)(request.body);
                volumes.set(volume.Name, volume);
                return { status: 201, body: JSON.stringify(volume) };
              }
              if (request.path === "/libpod/networks/create") {
                const body = Schema.decodeUnknownSync(
                  Schema.Struct({
                    name: Schema.String,
                    driver: Schema.Literal("bridge"),
                    dns_enabled: Schema.Literal(true),
                    options: Schema.Struct({ metric: Schema.Literal("50") }),
                    labels: Schema.Record(Schema.String, Schema.String),
                  }),
                )(request.body);
                networks.set(body.name, {
                  Id: body.name,
                  Name: body.name,
                  Driver: body.driver,
                  Labels: body.labels,
                });
                return { status: 201, body: "{}" };
              }
              if (request.path === "/networks/create") {
                const body = Schema.decodeUnknownSync(
                  Schema.Struct({
                    Name: Schema.String,
                    Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
                  }),
                )(request.body);
                networks.set(body.Name, { Id: body.Name, ...body });
                return { status: 201, body: "{}" };
              }
              if (request.path.startsWith("/networks/") && request.method === "GET") {
                const observed = networks.get(decodeURIComponent(request.path.slice("/networks/".length)));
                return { status: observed === undefined ? 404 : 200, body: JSON.stringify(observed ?? {}) };
              }
              if (request.method === "DELETE") {
                deleted.push(request.path);
                return { status: 204, body: "" };
              }
              return { status: 201, body: "{}" };
            }),
        },
      }),
    );
    // Then: the original outcome propagates without deleting established resources.
    expect(exit._tag).toBe("Failure");
    if (Exit.isFailure(exit)) {
      if (outcome === "fails") expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(failure);
      else expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(networks.has("lando-creation")).toBe(true);
    expect(volumes.get("data")?.Labels["dev.lando.volume-instance"]).toBeDefined();
    expect(deleted).toEqual([]);
  },
);

test("a persisted adoption receipt preserves an unlabeled volume without a previous plan", async () => {
  const store = { name: "data", scope: "app", kind: "data" } as const;
  const dataRoot = AbsolutePath.make("/local-data");
  const desired = {
    ...plan,
    stores: [store],
    identity: {
      appRoot: plan.root,
      ownerKey: appIdentityKey("owner", plan.root),
      dataRoot,
    },
  };
  const volume = {
    Name: store.name,
    Labels: {
      ...volumeOwnershipLabels(plan, store),
      "dev.lando.app": plan.id,
      "dev.lando.scope": "app",
      "dev.lando.store": store.name,
      "dev.lando.volume-instance": "populated",
    },
  };
  const inventory = [
    {
      kind: "volume" as const,
      nativeName: store.name,
      appId: plan.id,
      appRoot: plan.root,
      providerId: plan.provider,
      dataRoot,
      volumeInstance: "populated",
    },
  ];
  const result = await Effect.runPromise(
    bringUp(desired, {
      adoptionReceipts: inventory,
      ctx: { providerId: "podman", remediation: "test", env: {} },
      api: {
        request: ({ method, path }) => {
          if (method === "DELETE") return Effect.die("Existing data must never be deleted to claim it");
          if (path === "/volumes/create") return Effect.succeed({ status: 409, body: "{}" });
          if (path === "/volumes/data") return Effect.succeed({ status: 200, body: JSON.stringify(volume) });
          return Effect.succeed({ status: 200, body: "[]" });
        },
      },
    }).pipe(Effect.result),
  );
  expect(result).toMatchObject({ _tag: "Success", success: { createdVolumes: [] } });
});

test("an adoption receipt from a different data root cannot authorize an unlabeled volume", async () => {
  const store = { name: "data", scope: "app", kind: "data" } as const;
  const dataRoot = AbsolutePath.make("/local-data");
  const desired = {
    ...plan,
    stores: [store],
    identity: {
      appRoot: plan.root,
      ownerKey: appIdentityKey("owner", plan.root),
      dataRoot,
    },
  };
  const volume = {
    Name: store.name,
    Labels: {
      ...volumeOwnershipLabels(plan, store),
      "dev.lando.app": plan.id,
      "dev.lando.scope": "app",
      "dev.lando.store": store.name,
      "dev.lando.volume-instance": "populated",
    },
  };
  const inventory = [
    {
      kind: "volume" as const,
      nativeName: store.name,
      appId: plan.id,
      appRoot: plan.root,
      ownerKey: appIdentityKey("owner", plan.root),
      providerId: plan.provider,
      dataRoot: AbsolutePath.make("/foreign-data"),
      volumeClass: "data" as const,
      volumeScope: "app" as const,
      identityDigest: "digest",
    },
  ];
  const result = await Effect.runPromise(
    bringUp(desired, {
      adoptionReceipts: inventory,
      ctx: { providerId: "podman", remediation: "test", env: {} },
      api: {
        request: ({ method, path }) => {
          if (method === "DELETE") return Effect.die("Existing data must never be deleted to claim it");
          if (path === "/volumes/create") return Effect.succeed({ status: 409, body: "{}" });
          if (path === "/volumes/data") return Effect.succeed({ status: 200, body: JSON.stringify(volume) });
          return Effect.succeed({ status: 200, body: "[]" });
        },
      },
    }).pipe(Effect.result),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { operation: "bringUp.volume" } });
});
