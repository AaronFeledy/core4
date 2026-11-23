import { expect, test } from "bun:test";
import { ProviderUnavailableError, appliedStateVersionError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect } from "effect";
import type { EngineHttpRequest } from "../src/engine-api.ts";
import { makeOwnedResourcesCleanup } from "../src/resource-cleanup.ts";
import { type OwnedResource, makeResourceOwnershipStore } from "../src/resource-ownership.ts";
import { volumeCreationLabels } from "../src/volume-creation.ts";

test("a busy shared cache inventory entry does not prevent app resource removal", async () => {
  const root = AbsolutePath.make("/apps/consumer");
  const providerId = ProviderId.make("test");
  const appId = AppId.make("consumer");
  const plan = { root, provider: providerId, id: appId, extensions: {} };
  const owner = { appRoot: root, providerId, appId, ownerKey: appIdentityKey("owner", root) };
  const cache = { name: "shared", kind: "cache", scope: "global" } as const;
  const data = { name: "database", kind: "data", scope: "app" } as const;
  const store = makeResourceOwnershipStore(providerId);
  const volumes = new Map([
    [
      "shared",
      volumeCreationLabels(
        { ...plan, id: AppId.make("creator"), root: AbsolutePath.make("/apps/creator") },
        cache,
      ),
    ],
    ["database", volumeCreationLabels(plan, data)],
  ]);
  let networkPresent = true;
  const cleanup = makeOwnedResourcesCleanup({
    ctx: { providerId, remediation: "Retry.", env: {} },
    endpointNamespace: "test-daemon",
    store: {
      ...store,
      load: () =>
        Effect.succeed({
          ...owner,
          appIds: [appId],
          resources: [
            {
              ...owner,
              identityDigest: "cache",
              kind: "volume",
              nativeName: cache.name,
              volumeClass: cache.kind,
              volumeScope: cache.scope,
            },
            {
              ...owner,
              identityDigest: "data",
              kind: "volume",
              nativeName: data.name,
              volumeClass: data.kind,
              volumeScope: data.scope,
            },
            { ...owner, identityDigest: "net", kind: "network", nativeName: "private" },
          ],
        }),
      retire: () => Effect.void,
    },
    api: {
      request: ({ method, path }) =>
        Effect.sync(() => {
          if (path === "/networks/private") {
            if (method === "GET")
              return { status: 200, body: JSON.stringify({ Name: "private", Id: "private" }) };
            networkPresent = false;
            return { status: 204, body: "" };
          }
          const name = path.slice("/volumes/".length);
          if (method === "GET")
            return { status: 200, body: JSON.stringify({ Name: name, Labels: volumes.get(name) }) };
          if (name === "shared") return { status: 409, body: "volume is in use" };
          volumes.delete(name);
          return { status: 204, body: "" };
        }),
    },
  });
  const result = await Effect.runPromise(
    cleanup(root, { volumes: true, purgeCaches: true }).pipe(Effect.provide(makeTestStateStore().layer)),
  );
  expect(result).toMatchObject({
    networksRemoved: 1,
    volumesRemoved: { data: 1, cache: 0 },
    skipped: [{ appId, resource: "shared", reason: "in use" }],
  });
  expect([...volumes.keys()]).toEqual(["shared"]);
  expect(networkPresent).toBe(false);
});

test.each([204, 404])(
  "inventory cleanup removes anonymous volumes but retains named volumes with volumes:false (HTTP %s)",
  async (status) => {
    const root = AbsolutePath.make("/apps/owned");
    const owner = {
      appRoot: root,
      ownerKey: "owner",
      appId: AppId.make("app"),
      providerId: ProviderId.make("test"),
      identityDigest: "digest",
    };
    const container: OwnedResource = {
      ...owner,
      kind: "container",
      nativeName: "owned-container",
      service: ServiceName.make("web"),
    };
    const volume: OwnedResource = {
      ...owner,
      kind: "volume",
      nativeName: "retained-data",
      volumeClass: "data",
      volumeScope: "app",
    };
    const calls: EngineHttpRequest[] = [];
    const retired: OwnedResource[] = [];
    const cleanup = makeOwnedResourcesCleanup({
      ctx: { providerId: "test", remediation: "Retry cleanup.", env: {} },
      store: {
        ...makeResourceOwnershipStore("test"),
        load: () =>
          Effect.succeed({
            appRoot: root,
            ownerKey: "owner",
            providerId: owner.providerId,
            appIds: [owner.appId],
            resources: [container, volume],
          }),
        retire: (_root, resource) =>
          Effect.sync(() => {
            retired.push(resource);
          }),
      },
      api: {
        request: (request) =>
          Effect.sync(() => {
            calls.push(request);
            return request.method === "GET"
              ? {
                  status: 200,
                  body: JSON.stringify({
                    Id: "raw/id%2F",
                    Config: {
                      Labels: {
                        "dev.lando.app": "app",
                        "dev.lando.app-root": root,
                        "dev.lando.service": "web",
                      },
                    },
                  }),
                }
              : { status, body: "" };
          }),
      },
    });
    const result = await Effect.runPromise(cleanup(root, { volumes: false }));
    expect(calls).toEqual([
      { method: "GET", path: "/containers/owned-container/json" },
      { method: "DELETE", path: "/containers/raw%2Fid%252F?force=true&v=true" },
    ]);
    expect(retired).toEqual([container]);
    expect(result).toEqual({
      servicesRemoved: status === 204 ? [container.service] : [],
      networksRemoved: 0,
      volumesRemoved: { data: 0, cache: 0 },
    });
  },
);

const ownershipFixture = (input: {
  readonly kind?: "container" | "volume" | "network";
  readonly labels?: Readonly<Record<string, string>>;
  readonly freshLabels?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly transport?: boolean;
  readonly missingInventory?: boolean;
  readonly missingNativeId?: boolean;
  readonly appliedState?: ProviderUnavailableError | ReturnType<typeof appliedStateVersionError>;
}) => {
  const root = AbsolutePath.make("/apps/owned");
  const owner = {
    appRoot: root,
    ownerKey: appIdentityKey("owner", root),
    appId: AppId.make("app"),
    providerId: ProviderId.make("test"),
    identityDigest: "digest",
  };
  const resource: OwnedResource =
    input.kind === "volume"
      ? { ...owner, kind: "volume", nativeName: "data", volumeClass: "data", volumeScope: "app" }
      : input.kind === "network"
        ? { ...owner, kind: "network", nativeName: "private" }
        : { ...owner, kind: "container", nativeName: "container", service: ServiceName.make("web") };
  const labels =
    input.kind === "volume"
      ? {
          "dev.lando.app": "app",
          "dev.lando.volume-owner": root,
          "dev.lando.volume-selector": `test:app:${owner.ownerKey}:data`,
          "dev.lando.scope": "app",
          "dev.lando.volume-instance": "one",
        }
      : input.kind === "network"
        ? {
            "dev.lando.app": "app",
            "dev.lando.app-root": root,
            "dev.lando.owner": owner.ownerKey,
            "dev.lando.provider": "test",
          }
        : { "dev.lando.app": "app", "dev.lando.app-root": root, "dev.lando.service": "web" };
  const calls: EngineHttpRequest[] = [];
  const retired: OwnedResource[] = [];
  let inspections = 0;
  const { appliedState } = input;
  const cleanup = makeOwnedResourcesCleanup({
    ...(appliedState === undefined ? {} : { checkAppliedState: () => Effect.fail(appliedState) }),
    ctx: { providerId: "test", remediation: "Retry cleanup.", env: {} },
    endpointNamespace: "test-daemon",
    store: {
      ...makeResourceOwnershipStore("test"),
      load: () =>
        Effect.succeed(
          input.missingInventory ? undefined : { ...owner, appIds: [owner.appId], resources: [resource] },
        ),
      retire: (_root, resource) =>
        Effect.sync(() => {
          retired.push(resource);
        }),
    },
    api: {
      request: (request) => {
        calls.push(request);
        if (request.method === "GET") {
          inspections++;
          const observedLabels =
            inspections > 1
              ? { ...labels, ...input.labels, ...input.freshLabels }
              : { ...labels, ...input.labels };
          return Effect.succeed({
            status: 200,
            body: JSON.stringify({
              ...(input.missingNativeId ? {} : { Id: "exact-id" }),
              Name: resource.nativeName,
              Labels: observedLabels,
              Config: { Labels: observedLabels },
            }),
          });
        }
        return input.transport
          ? Effect.fail(
              new ProviderUnavailableError({
                providerId: "test",
                operation: "delete",
                message: "unreachable",
                remediation: "Retry cleanup.",
              }),
            )
          : Effect.succeed({ status: input.status ?? 204, body: "" });
      },
    },
  });
  return {
    calls,
    retired,
    run: () =>
      Effect.runPromise(
        cleanup(root, { volumes: true }).pipe(Effect.provide(makeTestStateStore().layer), Effect.result),
      ),
  };
};

for (const input of [
  { status: 500 },
  { transport: true },
  { labels: { "dev.lando.app-root": "/apps/same-name-other-root" } },
  { labels: { "dev.lando.provider": "podman" } },
  { labels: { "dev.lando.owner": "other-owner" } },
  { labels: { "dev.lando.role": "data-helper" } },
  { labels: { "dev.lando.scratch": "TRUE" } },
  { labels: { "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": "other" } },
  { kind: "network", labels: { "dev.lando.owner": "other-owner" } },
  { kind: "volume", labels: { "dev.lando.volume-owner": "/apps/other" } },
  { kind: "volume", labels: { "dev.lando.volume-selector": "test:app:wrong:data" } },
] as const) {
  test(`inventory retains unresolved ownership or deletion ${JSON.stringify(input)}`, async () => {
    const fixture = ownershipFixture(input);
    expect(await fixture.run()).toMatchObject({ _tag: "Failure" });
    expect(fixture.retired).toEqual([]);
    if ("labels" in input || "freshLabels" in input)
      expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
  });
}

test("inventory leaves a replaced app volume alone", async () => {
  const fixture = ownershipFixture({ kind: "volume", freshLabels: { "dev.lando.volume-instance": "two" } });
  expect(await fixture.run()).toMatchObject({
    _tag: "Success",
    success: { skipped: [{ resource: "data", reason: "volume changed after enumeration" }] },
  });
  expect(fixture.retired).toEqual([]);
  expect(fixture.calls.some(({ method }) => method === "DELETE")).toBe(false);
});

test("an inventory container refusal names the container and the label that failed", async () => {
  // Given a recorded container whose live provider label contradicts the acting provider.
  const fixture = ownershipFixture({ labels: { "dev.lando.provider": "podman" } });
  // When / Then
  expect(await fixture.run()).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderUnavailableError",
      operation: "resource-ownership",
      details: { label: "dev.lando.provider" },
    },
  });
});

test("an inventory container refusal names a container the runtime reports without a native id", async () => {
  // Given a recorded container whose inspection carries matching labels but no id.
  const fixture = ownershipFixture({ missingNativeId: true });
  // When
  const outcome = await fixture.run();
  // Then the refusal names the container and nothing is deleted.
  expect(outcome).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderUnavailableError",
      operation: "resource-ownership",
      details: { container: "container" },
    },
  });
  expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
});

test("missing ownership inventory authorizes no native discovery or deletion", async () => {
  const fixture = ownershipFixture({ missingInventory: true });
  expect(await fixture.run()).toMatchObject({
    _tag: "Success",
    success: {
      servicesRemoved: [],
      volumesRemoved: { data: 0, cache: 0 },
      networksRemoved: 0,
    },
  });
  expect(fixture.calls).toEqual([]);
});

for (const kind of ["container", "volume"] as const)
  test(`a protected applied-state skip keeps its tag and remediation for a ${kind}`, async () => {
    const newer = appliedStateVersionError({
      path: "/state/app.json",
      storedVersion: 99,
      supportedVersion: 1,
      appId: "app",
      providerId: "test",
      operation: "applied-state.read",
      scope: "app",
    });
    const unreadable = new ProviderUnavailableError({
      providerId: "test",
      operation: "applied-state.read",
      message: "Applied state is unreadable.",
      remediation: "Restore the applied-state record.",
    });
    for (const error of [newer, unreadable]) {
      const fixture = ownershipFixture({ kind, appliedState: error });
      expect(await fixture.run()).toMatchObject({
        _tag: "Success",
        success: {
          skipped: [{ reason: error.message, errorTag: error._tag, remediation: error.remediation }],
        },
      });
      expect(fixture.calls).toEqual([]);
      expect(fixture.retired).toEqual([]);
    }
  });
