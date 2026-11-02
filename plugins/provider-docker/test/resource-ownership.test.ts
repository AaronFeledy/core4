import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { makeResourceOwnershipStore } from "@lando/container-runtime/provider-assembly";
import { makeRuntimeProvider } from "@lando/provider-docker";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, landoAppNetworkName, landoNetworkingPlan } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { webFor, withInventory } from "./resource-ownership-support.ts";

test("ownership survives repeated attempts and renamed app identities without storing configuration", async () => {
  await withInventory(async ({ store, plan, root, path }) => {
    // Given
    const first = webFor(plan);
    await Effect.runPromise(store.prepare(first));
    const renamed = { ...first, id: AppId.make("renamed"), slug: "renamed" };
    // When
    await Effect.runPromise(store.prepare(renamed));
    await Effect.runPromise(store.prepare(renamed));
    const inventory = await Effect.runPromise(store.load(root));
    // Then
    expect(inventory?.appIds).toEqual([plan.id, renamed.id]);
    expect(inventory?.resources).toHaveLength(4);
    expect(await readFile(path, "utf8")).not.toContain("never-persist-this");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

test("scratch network proof survives store round trip and replaces an exact old four-label hint", async () => {
  await withInventory(async ({ store, plan, root, path }) => {
    const scratch = { ...plan, extensions: { "@lando/core/scratch": { id: plan.id } } };
    await Effect.runPromise(store.prepare(plan));
    const old = (await Effect.runPromise(store.load(root)))?.resources.find(
      (item) => item.kind === "network",
    );
    expect(old?.kind === "network" && old.scratchId).toBeUndefined();
    await Effect.runPromise(store.prepare(scratch, plan));
    const resources = (await Effect.runPromise(store.load(root)))?.resources;
    expect(resources).toHaveLength(1);
    expect(resources?.[0]).toMatchObject({ kind: "network", scratchId: plan.id });
    expect(resources?.[0]?.identityDigest).not.toBe(old?.identityDigest);
    await Effect.runPromise(store.prepare(scratch, plan));
    expect((await Effect.runPromise(store.load(root)))?.resources).toHaveLength(1);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain(`"scratchId": "${plan.id}"`);
    await writeFile(path, raw.replace(`"scratchId": "${plan.id}"`, '"scratchId": "foreign"'));
    expect(Result.isFailure(await Effect.runPromise(store.load(root).pipe(Effect.result)))).toBe(true);
    const envelope = JSON.parse(raw) as { data: { resources: Array<Record<string, unknown>> } };
    const entry = envelope.data.resources[0];
    if (entry === undefined) throw new TypeError("missing scratch network identity");
    entry.scratchId = "foreign";
    const { identityDigest: _digest, ...identity } = entry;
    entry.identityDigest = sha256Hex(canonicalJson(identity));
    await writeFile(path, JSON.stringify(envelope));
    expect(Result.isFailure(await Effect.runPromise(store.load(root).pipe(Effect.result)))).toBe(true);
  });
});

test("ordinary final plan cannot downgrade persisted scratch network proof", async () => {
  await withInventory(async ({ store, plan, root }) => {
    const scratch = { ...plan, extensions: { "@lando/core/scratch": { id: plan.id } } };
    await Effect.runPromise(store.prepare(scratch));
    const ordinaryWithVolume = {
      ...plan,
      stores: [{ name: "data", kind: "data" as const, scope: "app" as const }],
    };
    const result = await Effect.runPromise(store.prepare(ordinaryWithVolume, scratch).pipe(Effect.result));
    expect(Result.isFailure(result)).toBe(true);
    const resources = (await Effect.runPromise(store.load(root)))?.resources;
    expect(resources).toHaveLength(1);
    expect(resources?.[0]).toMatchObject({ kind: "network", scratchId: plan.id });
  });
});

for (const damage of ["corrupt", "version", "digest", "root", "provider"] as const) {
  test(`rejects ${damage} ownership state before physical cleanup`, async () => {
    await withInventory(async ({ store, plan, root, path, calls, cleanup }) => {
      // Given
      await Effect.runPromise(store.prepare(plan));
      const raw = await readFile(path, "utf8");
      const broken =
        damage === "corrupt"
          ? "{"
          : damage === "version"
            ? raw.replace(/"version":\s*1/u, '"version":99')
            : damage === "digest"
              ? raw.replace(/"identityDigest":\s*"/u, '"identityDigest":"bad')
              : damage === "provider"
                ? raw.replaceAll(/"providerId":\s*"docker"/gu, '"providerId":"podman"')
                : raw.replaceAll(root, "/foreign");
      await writeFile(path, broken);
      // When
      const result = await Effect.runPromise(cleanup(root, { volumes: true }).pipe(Effect.result));
      // Then
      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toEqual([]);
    });
  });
}

test("removes a private network by fresh native identity and retires its hint", async () => {
  await withInventory(async ({ store, plan, root, observations, network, cleanup, calls }) => {
    // Given
    await Effect.runPromise(store.prepare(plan));
    observations.set(`/networks/${landoAppNetworkName(plan)}`, network());
    // When
    const result = await Effect.runPromise(cleanup(root, { volumes: false }));
    // Then
    expect(result).toEqual({ servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/networks/network-owned",
    ]);
    expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
  });
});

test("retires all absent hints while reporting no physical change", async () => {
  await withInventory(async ({ store, plan, root, cleanup }) => {
    // Given
    await Effect.runPromise(
      store.prepare(webFor({ ...plan, stores: [{ name: "data", kind: "data", scope: "app" }] })),
    );
    // When
    const result = await Effect.runPromise(cleanup(root, { volumes: true }));
    // Then
    expect(result).toEqual({ servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 });
    expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
  });
});

test("retains data volume hints unless policy selects their removal", async () => {
  await withInventory(async ({ store, plan, root, cleanup }) => {
    // Given
    await Effect.runPromise(
      store.prepare({ ...plan, stores: [{ name: "data", kind: "data", scope: "app" }] }),
    );
    // When
    const result = await Effect.runPromise(cleanup(root, { volumes: false }));
    // Then
    expect(result.volumesRemoved).toBe(0);
    expect((await Effect.runPromise(store.load(root)))?.resources.map((resource) => resource.kind)).toEqual([
      "volume",
    ]);
  });
});

for (const legacy of [{ Labels: {} }, { Labels: null }, {}]) {
  test(`legacy unlabeled network hint is removed by observed Id and retired ${JSON.stringify(legacy)}`, async () => {
    await withInventory(async ({ store, plan, root, observations, cleanup, calls }) => {
      // Given
      await Effect.runPromise(store.prepare(plan));
      observations.set(`/networks/${landoAppNetworkName(plan)}`, {
        Id: "legacy-network",
        Name: landoAppNetworkName(plan),
        ...legacy,
      });
      // When
      const result = await Effect.runPromise(cleanup(root, { volumes: false }));
      // Then
      expect(result).toEqual({ servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 });
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
        "/networks/legacy-network",
      ]);
      expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
    });
  });
}

test.each(["lando_bridge_network", undefined])(
  "refuses an unlabeled network with unproven name: %s",
  async (name) => {
    await withInventory(async ({ store, plan, root, observations, cleanup, calls }) => {
      // Given an inventory hint resolving to a differently named or unnamed network.
      await Effect.runPromise(store.prepare(plan));
      observations.set(`/networks/${landoAppNetworkName(plan)}`, {
        Id: "foreign-network",
        Name: name,
        Labels: {},
      });
      // When cleanup verifies the hint against native inspect.
      const result = await Effect.runPromise(cleanup(root, { volumes: false }).pipe(Effect.result));
      // Then refusal preserves both the native resource and its unresolved hint.
      expect(Result.isFailure(result)).toBe(true);
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
      expect(await Effect.runPromise(store.summary(root))).toBeDefined();
    });
  },
);

for (const proof of ["foreign", "partial", "provider", "unrelated", "extra"] as const) {
  test(`refuses ${proof} network proof without deletion or retirement`, async () => {
    await withInventory(async ({ store, plan, root, cleanup, observations, network, calls }) => {
      // Given
      await Effect.runPromise(store.prepare(plan));
      const observed = network();
      observations.set(`/networks/${landoAppNetworkName(plan)}`, {
        ...observed,
        Labels:
          proof === "partial"
            ? { "dev.lando.app": plan.id }
            : proof === "unrelated"
              ? { unrelated: "label" }
              : {
                  ...observed.Labels,
                  ...(proof === "foreign"
                    ? { "dev.lando.app-root": "/foreign" }
                    : proof === "extra"
                      ? { unrelated: "label" }
                      : { "dev.lando.provider": "podman" }),
                },
      });
      // When
      const result = await Effect.runPromise(cleanup(root, { volumes: false }).pipe(Effect.result));
      // Then
      expect(Result.isFailure(result)).toBe(true);
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
      expect(await Effect.runPromise(store.summary(root))).toBeDefined();
    });
  });
}

test("keeps incomplete hints on partial cleanup and resumes after a retry", async () => {
  await withInventory(async ({ store, plan, root, cleanup, observations, network, setDeleteStatus }) => {
    // Given
    await Effect.runPromise(store.prepare(webFor(plan)));
    observations.set(`/networks/${landoAppNetworkName(plan)}`, network());
    setDeleteStatus(500);
    // When
    const failed = await Effect.runPromise(cleanup(root, { volumes: false }).pipe(Effect.result));
    // Then
    expect(Result.isFailure(failed)).toBe(true);
    expect((await Effect.runPromise(store.load(root)))?.resources.map((resource) => resource.kind)).toEqual([
      "network",
    ]);
    setDeleteStatus(204);
    expect((await Effect.runPromise(cleanup(root, { volumes: false }))).networksRemoved).toBe(1);
  });
});

const failingWrites = (state: PluginStateStore): PluginStateStore => ({
  ...state,
  open: (spec) =>
    state.open(spec).pipe(
      Effect.map((bucket) => ({
        ...bucket,
        modify: () =>
          Effect.fail(
            new StateStoreError({
              reason: "io",
              operation: "modify",
              remediation: "Injected modify failure for resource-ownership fixture.",
            }),
          ),
      })),
    ),
});

test("shared networks are never claimed or selected for cleanup", async () => {
  await withInventory(async ({ store, plan, root, cleanup, calls }) => {
    // Given
    const global = {
      ...plan,
      id: AppId.make("global"),
      networking: landoNetworkingPlan({
        slug: "global",
        serviceNames: [],
        sharedCrossAppNetwork: true,
        perAppBridge: false,
      }),
    };
    await Effect.runPromise(store.prepare(global));
    // When
    const result = await Effect.runPromise(cleanup(root, { volumes: true }));
    // Then
    expect(result.networksRemoved).toBe(0);
    expect(calls).toEqual([]);
    expect(await Effect.runPromise(store.summary(root))).toBeUndefined();
  });
});

test("mutating apply without a durable store fails before action", async () => {
  await withInventory(async ({ plan, calls }) => {
    // Given
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        dockerApi: {
          info: Effect.succeed({}),
          request: (request) =>
            Effect.sync(() => {
              calls.push(request);
              return { status: 404, body: "" };
            }),
        },
      }),
    );
    // When
    const result = await Effect.runPromise(
      Effect.scoped(provider.apply(plan, { reconcile: false })).pipe(Effect.result),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toEqual([]);
  });
});

test("durable inventory write failure prevents any app resource mutation", async () => {
  await withInventory(async ({ state, plan, calls }) => {
    // Given
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        appliedPlanState: failingWrites(state),
        dockerApi: {
          info: Effect.succeed({}),
          request: (request) =>
            Effect.sync(() => {
              calls.push(request);
              return { status: 404, body: "" };
            }),
        },
      }),
    );
    calls.length = 0;
    // When
    const result = await Effect.runPromise(
      Effect.scoped(provider.apply(plan, { reconcile: false })).pipe(Effect.result),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toEqual([]);
  });
});

test("propagates retirement failure and retains the hint for verified-absence retry", async () => {
  await withInventory(async ({ state, store, plan, root }) => {
    // Given
    await Effect.runPromise(store.prepare(plan));
    const resource = (await Effect.runPromise(store.load(root)))?.resources[0];
    if (resource === undefined) throw new TypeError("missing network fixture");
    const broken = makeResourceOwnershipStore("docker", failingWrites(state));
    // When
    const result = await Effect.runPromise(broken.retire(root, resource).pipe(Effect.result));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(await Effect.runPromise(store.summary(root))).toBeDefined();
  });
});
