import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  LANDO_DATA_ROOT_LABEL,
  LANDO_NETWORK_ROLE_LABEL,
  LANDO_SHARED_NETWORK_ROLE,
  ProviderId,
  appIdentityKey,
  landoSharedCrossAppNetworkName,
} from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import { makeAppliedPlanStore } from "../src/applied-state.ts";
import {
  type DataRootPurgeOptions,
  preflightDataRootPurge,
  preflightRecordedPurge,
} from "../src/data-root-purge.ts";
import type { EngineHttpApi, EngineHttpResponse } from "../src/engine-api.ts";
import { dockerEngineIdentity } from "../src/engine-identity.ts";
import { BUILT_ARTIFACT_STORE_LABEL } from "../src/image-build.ts";
import { volumeSelectorValue } from "../src/podman/volume-prune.ts";
import { makeResourceOwnershipStore } from "../src/resource-ownership.ts";
import { plan } from "./fixtures/environment-values.ts";

const dataRoot = "/installation/a";
const appRoot = "/project/web";
const pluginId = "@lando/provider-docker";
const options = { endpoint: "/fake/engine.sock", dataRoot, buildStore: "abcd1234", pluginId };
const ctx = { providerId: "docker", remediation: "Start the engine and retry.", env: {} };
const rootLabels = { [LANDO_DATA_ROOT_LABEL]: dataRoot };
const appLabels = {
  ...rootLabels,
  "dev.lando.app": "web",
  "dev.lando.app-root": appRoot,
  "dev.lando.provider": "podman",
  "dev.lando.owner": appIdentityKey("owner", appRoot),
};
const bridge = landoSharedCrossAppNetworkName(dataRoot);
const tags = ["localhost/lando-build-abcd1234-web:latest", "lando-build-abcd1234-db:latest"];

const fixture = ({
  attached = false,
  changed = false,
  foreign = false,
  used = false,
  reachable = true,
  legacy = false,
} = {}) => {
  const containers = new Map<string, Readonly<Record<string, string>>>([
    ["owned", { ...appLabels, "dev.lando.service": "web" }],
    ["peer", { ...appLabels, "dev.lando.service": "web", [LANDO_DATA_ROOT_LABEL]: "/installation/b" }],
  ]);
  const networks = new Map<string, { Name: string; Labels: Readonly<Record<string, string>> }>([
    [
      "bridge",
      { Name: bridge, Labels: { ...rootLabels, [LANDO_NETWORK_ROLE_LABEL]: LANDO_SHARED_NETWORK_ROLE } },
    ],
    ["private", { Name: "web-private", Labels: appLabels }],
  ]);
  const volumes = new Map<string, Readonly<Record<string, string>>>([
    [
      "db",
      {
        ...appLabels,
        "dev.lando.volume-owner": appRoot,
        "dev.lando.volume-selector": volumeSelectorValue({
          providerId: "podman",
          appId: "web",
          ownerKey: appIdentityKey("owner", appRoot),
          volumeClass: "data",
        }),
        "dev.lando.scope": "app",
        "dev.lando.store": "db",
        "dev.lando.volume-instance": "original",
      },
    ],
  ]);
  if (legacy) {
    const { [LANDO_DATA_ROOT_LABEL]: _root, ...labels } = appLabels;
    const legacyLabels = { ...labels, "dev.lando.provider": "docker" };
    containers.set("adopted", { ...legacyLabels, "dev.lando.service": "web" });
    containers.set("replacement", { ...legacyLabels, "dev.lando.service": "web" });
    networks.set("adopted-net", { Name: "legacy-private", Labels: legacyLabels });
    const db = volumes.get("db");
    const { [LANDO_DATA_ROOT_LABEL]: _volumeRoot, ...volumeLabels } = db ?? {};
    volumes.set("legacy-db", {
      ...volumeLabels,
      "dev.lando.provider": "docker",
      "dev.lando.store": "legacy-db",
      "dev.lando.volume-selector": volumeSelectorValue({
        providerId: "docker",
        appId: "web",
        ownerKey: appIdentityKey("owner", appRoot),
        volumeClass: "data",
      }),
    });
    const legacyDb = volumes.get("legacy-db") ?? {};
    volumes.set("recreated-db", { ...legacyDb, "dev.lando.store": "recreated-db" });
  }
  const imageTags = new Set(foreign ? [...tags, "my-project:latest"] : tags);
  const actions: string[] = [];
  let volumeReads = 0;
  const json = (value: unknown, status = 200): EngineHttpResponse => ({
    status,
    body: JSON.stringify(value),
  });
  const missing = json(null, 404);
  const api: EngineHttpApi = {
    request: ({ method, path }) =>
      Effect.sync(() => {
        const url = new URL(path, "http://fixture.invalid");
        const [, kind, rawRef, verb] = url.pathname.split("/");
        const ref = decodeURIComponent(rawRef ?? "");
        if (kind === "_ping") return json(null, reachable ? 200 : 503);
        const filter: unknown = JSON.parse(url.searchParams.get("filters") ?? "{}");
        const values = (key: string): readonly string[] => {
          const selected: unknown =
            typeof filter === "object" && filter !== null ? Reflect.get(filter, key) : undefined;
          return Array.isArray(selected)
            ? selected.filter((value): value is string => typeof value === "string")
            : [];
        };
        const matches = (labels: Readonly<Record<string, string>>) =>
          values("label").every((label) =>
            Object.entries(labels).some(([key, value]) => label === key || label === `${key}=${value}`),
          );
        if (kind === "containers" && ref === "json") {
          if (values("ancestor").length) return json(used ? [{ Id: "peer" }] : []);
          if (values("network").length) return json(attached ? [{ Id: "peer" }] : []);
          return json([...containers].filter(([, labels]) => matches(labels)).map(([Id]) => ({ Id })));
        }
        if (kind === "networks" && !ref)
          return json([...networks].filter(([, value]) => matches(value.Labels)).map(([Id]) => ({ Id })));
        if (kind === "volumes" && !ref)
          return json({
            Volumes: [...volumes].filter(([, labels]) => matches(labels)).map(([Name]) => ({ Name })),
          });
        if (kind === "images" && ref === "json")
          return json(imageTags.size ? [{ Id: "sha256:image", RepoTags: [...imageTags] }] : []);
        if (method === "POST" && kind === "containers" && verb === "stop") {
          actions.push(`stop:${ref}`);
          return containers.has(ref) ? json(null, 204) : missing;
        }
        if (method === "DELETE") {
          actions.push(`${kind}:${ref}`);
          if (kind === "containers" && url.searchParams.get("force") === "true" && containers.delete(ref))
            return json(null, 204);
          if (kind === "networks" && networks.delete(ref)) return json(null, 204);
          if (kind === "volumes" && !url.searchParams.has("force") && volumes.delete(ref))
            return json(null, 204);
          if (kind === "images" && !url.searchParams.has("force") && imageTags.delete(ref)) return json([]);
          return json(null, 500);
        }
        if (kind === "containers" && containers.has(ref))
          return json({
            Id: ref,
            Name: ref === "adopted" || ref === "replacement" ? "/legacy-web" : `/${ref}`,
            Config: { Labels: containers.get(ref) },
          });
        if (kind === "networks" && networks.has(ref))
          return json({
            Id: ref,
            ...networks.get(ref),
            Containers: ref === "bridge" && attached ? { peer: {} } : {},
          });
        if (kind === "volumes" && volumes.has(ref))
          return json({
            Name: ref,
            Labels: {
              ...volumes.get(ref),
              "dev.lando.volume-instance": changed && ++volumeReads >= 3 ? "replacement" : "original",
            },
          });
        if (kind === "images" && (ref === "sha256:image" || imageTags.has(ref)))
          return json({
            Id: "image",
            RepoTags: [...imageTags],
            Config: { Labels: { [BUILT_ARTIFACT_STORE_LABEL]: options.buildStore } },
          });
        return missing;
      }),
  };
  return { api, actions, containers };
};

const sweep = async (api: EngineHttpApi, opts: DataRootPurgeOptions = options) => {
  const prepared = await Effect.runPromise(preflightDataRootPurge(api, ctx, opts));
  if (prepared.kind !== "reachable") throw new Error(`Fixture unexpectedly skipped: ${prepared.reason}`);
  return Effect.runPromise(prepared.sweep());
};

test("deletes only this root's objects in dependency order, with owned images removed by tag", async () => {
  const { api, actions, containers } = fixture();
  const result = await sweep(api);
  expect(result).toMatchObject({ outsideScope: 1, retained: [], failed: [] });
  expect(actions).toEqual([
    "stop:owned",
    "containers:owned",
    "networks:private",
    "networks:bridge",
    "volumes:db",
    ...tags.map((tag) => `images:${tag}`),
  ]);
  expect([...containers.keys()]).toEqual(["peer"]);
});

const withInventory = async (run: (opts: typeof options, pluginRoot: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-purge-")));
  try {
    await run(
      { ...options, dataRoot: root },
      makeLandoPaths({ userDataRoot: root }).pluginStateDir(pluginId),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("purge needs the recorded daemon, including when a different socket aliases it", () =>
  withInventory(async (opts, pluginRoot) => {
    const access = { enforce: async () => undefined, verify: async () => undefined };
    const state = makePluginStateStore(
      makeStateStore({ privateFileAccess: access }),
      AbsolutePath.make(pluginRoot),
      access,
    );
    const store = makeAppliedPlanStore({ providerId: "docker", layout: "per-app" });
    const recorded = dockerEngineIdentity({ ID: "A" }, "unix:///recorded.sock");
    if (!recorded) throw new Error("Expected a Docker identity");
    const applied = { ...plan, engineIdentity: recorded };
    await Effect.runPromise(store.persistAppliedPlan(state, applied));
    const { api, actions } = fixture();
    let daemon = "B";
    const prepare = preflightRecordedPurge(ctx, opts, store.listAppliedPlans, {
      api: { ...api, info: Effect.sync(() => ({ ID: daemon })) },
      endpoint: "tcp://proxy:2375",
      identify: dockerEngineIdentity,
    });
    const wrong = await Effect.runPromise(Effect.flip(prepare));
    expect(wrong.message).toContain("unix:///recorded.sock");
    expect(wrong.message).toContain("tcp://proxy:2375");
    const skipped = await Effect.runPromise(
      Effect.flip(
        preflightRecordedPurge(ctx, opts, store.listAppliedPlans, {
          kind: "skipped",
          endpoint: "Docker context",
          reason: "Unsupported transport",
        }),
      ),
    );
    expect(skipped.message).toContain("unix:///recorded.sock");
    daemon = "A";
    const found = await Effect.runPromise(prepare);
    if (found.kind !== "reachable") throw new Error("Expected alias to reach the recorded daemon");
    daemon = "B";
    expect((await Effect.runPromise(found.sweep())).retained.length).toBeGreaterThan(0);
    expect(actions).toEqual([]);
    expect((await Effect.runPromise(store.loadAppliedPlanStrict(state, plan.id)))?.engineIdentity).toEqual(
      recorded,
    );
  }));

test("purges exactly receipted legacy objects and leaves replacements and peer-labeled objects alone", () =>
  withInventory(async (opts, pluginRoot) => {
    const access = { enforce: async () => undefined, verify: async () => undefined };
    const state = makePluginStateStore(
      makeStateStore({ privateFileAccess: access }),
      AbsolutePath.make(pluginRoot),
      access,
    );
    const { api, containers, actions } = fixture({ legacy: true });
    const owner = {
      appId: AppId.make("web"),
      appRoot: AbsolutePath.make(appRoot),
      providerId: ProviderId.make(ctx.providerId),
      dataRoot: AbsolutePath.make(opts.dataRoot),
    };
    await Effect.runPromise(
      makeResourceOwnershipStore(ctx.providerId, state).recordAdoption(
        owner.appRoot,
        {
          dataRoot: owner.dataRoot,
          previousAppId: owner.appId,
          receipts: [
            { ...owner, kind: "container", nativeName: "legacy-web", nativeId: "adopted" },
            { ...owner, kind: "container", nativeName: "peer", nativeId: "peer" },
            { ...owner, kind: "network", nativeName: "legacy-private", nativeId: "adopted-net" },
            { ...owner, kind: "volume", nativeName: "legacy-db", volumeInstance: "original" },
            { ...owner, kind: "volume", nativeName: "recreated-db", volumeInstance: "retired" },
            { ...owner, kind: "volume", nativeName: "db", volumeInstance: "original" },
          ],
        },
        [],
      ),
    );

    const first = await Effect.runPromise(preflightDataRootPurge(api, ctx, opts));
    const second = await Effect.runPromise(preflightDataRootPurge(api, ctx, opts));
    if (first.kind !== "reachable" || second.kind !== "reachable")
      throw new Error("Expected both preflights to succeed");
    expect(first.counts).toEqual({ container: 1, volume: 1, network: 1, image: 1 });
    expect(await Effect.runPromise(first.sweep())).toMatchObject({ retained: [], failed: [] });
    expect(await Effect.runPromise(second.sweep())).toMatchObject({ removed: [], retained: [], failed: [] });
    expect(actions).toEqual([
      "stop:adopted",
      "containers:adopted",
      "networks:adopted-net",
      "volumes:legacy-db",
      ...tags.map((tag) => `images:${tag}`),
    ]);
    expect([...containers.keys()]).toEqual(["owned", "peer", "replacement"]);
  }));

test.each(["corrupt record", "unreadable directory"])(
  "blocks purge on %s without modifying inventory",
  (problem) =>
    withInventory(async (opts, pluginRoot) => {
      const dir = join(pluginRoot, "resource-ownership");
      const file = problem === "corrupt record" ? join(dir, `${appIdentityKey("owner", appRoot)}.json`) : dir;
      await mkdir(problem === "corrupt record" ? dir : pluginRoot, { recursive: true });
      await Bun.write(file, "not an inventory");
      const { api, actions } = fixture();
      await expect(sweep(api, opts)).rejects.toMatchObject({
        _tag: "ProviderUnavailableError",
        remediation: expect.stringContaining("Repair the provider plugin state"),
      });
      expect(await Bun.file(file).text()).toBe("not an inventory");
      expect(actions).toEqual([]);
    }),
);

test.each([
  [{ attached: true }, "network bridge:", "networks:bridge"],
  [{ changed: true }, "volume generation or ownership changed", "volumes:db"],
  [{ foreign: true }, "foreign tags", `images:${tags[0]}`],
  [{ used: true }, "in use", `images:${tags[0]}`],
] as const)("retains an unsafe deletion: %j", async (scenario, reason, forbidden) => {
  const { api, actions } = fixture(scenario);
  const result = await sweep(api);
  expect(result.failed).toEqual([]);
  expect(result.retained).toHaveLength(1);
  expect(result.retained[0]).toContain(reason);
  expect(actions).not.toContain(forbidden);
});

test("reports an unreachable endpoint without listing or removing anything", async () => {
  const { api, actions } = fixture({ reachable: false });
  const result = await Effect.runPromise(preflightDataRootPurge(api, ctx, options));
  expect(result).toEqual({ kind: "skipped", endpoint: options.endpoint, reason: "HTTP 503" });
  expect(actions).toEqual([]);
});
