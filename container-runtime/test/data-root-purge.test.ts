import { expect, test } from "bun:test";
import {
  LANDO_DATA_ROOT_LABEL,
  LANDO_NETWORK_ROLE_LABEL,
  LANDO_SHARED_NETWORK_ROLE,
  appIdentityKey,
  landoSharedCrossAppNetworkName,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import { type DataRootPurgeOptions, preflightDataRootPurge } from "../src/data-root-purge.ts";
import type { EngineHttpApi, EngineHttpResponse } from "../src/engine-api.ts";
import { BUILT_ARTIFACT_STORE_LABEL } from "../src/image-build.ts";
import { volumeSelectorValue } from "../src/podman/volume-prune.ts";

const dataRoot = "/installation/a";
const appRoot = "/project/web";
const options = { endpoint: "/fake/engine.sock", dataRoot, buildStore: "abcd1234" };
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
  if (legacy)
    containers.set("adopted", {
      "dev.lando.app": "web",
      "dev.lando.app-root": appRoot,
      "dev.lando.service": "web",
    });
  const networks = new Map([
    [
      "bridge",
      { Name: bridge, Labels: { ...rootLabels, [LANDO_NETWORK_ROLE_LABEL]: LANDO_SHARED_NETWORK_ROLE } },
    ],
    ["private", { Name: "web-private", Labels: appLabels }],
  ]);
  const volumes = new Map([
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
          return json({ Id: ref, Name: `/${ref}`, Config: { Labels: containers.get(ref) } });
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

test("an injected ownership decision can admit an exact legacy object without adopting its peers", async () => {
  const { api, containers } = fixture({ legacy: true });
  const result = await sweep(api, {
    ...options,
    owns: ({ kind, id, labels }) =>
      labels[LANDO_DATA_ROOT_LABEL] === dataRoot ||
      (kind === "container" && id === "adopted" && labels[LANDO_DATA_ROOT_LABEL] === undefined),
  });
  expect(result.failed).toEqual([]);
  expect([...containers.keys()]).toEqual(["peer"]);
});

test("a second sweep of the same engine has no removals", async () => {
  const { api } = fixture();
  const first = await Effect.runPromise(preflightDataRootPurge(api, ctx, options));
  const second = await Effect.runPromise(preflightDataRootPurge(api, ctx, options));
  if (first.kind !== "reachable" || second.kind !== "reachable")
    throw new Error("Expected both preflights to succeed");
  await Effect.runPromise(first.sweep());
  expect(await Effect.runPromise(second.sweep())).toMatchObject({
    removed: [],
    retained: [],
    failed: [],
    outsideScope: 1,
  });
});

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
