import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  classifyVolumeHolder,
  ephemeralDataHelperLabels,
  ephemeralDataHelperNamePrefix,
  isEphemeralDataHelperName,
  isVolumeInUse,
  namedHolders,
  releaseVolumeHolders,
  removeEphemeralDataHelpers,
  removeUnlabeledEphemeralDataHolders,
  volumeInUseRemediation,
} from "../src/ephemeral-data-helpers.ts";
import type { HelperHttpRequest, HelperHttpResponse, VolumeHolder } from "../src/ephemeral-data-helpers.ts";

const helperLabels = {
  "dev.lando.role": "data-helper",
  "dev.lando.app": "app-id",
  "dev.lando.provider": "test",
  "dev.lando.store": "data",
} as const;

const helper = {
  Id: "helper-1",
  Names: ["/lando-test-data-11111111-1111-4111-8111-111111111111"],
  State: "exited",
  Labels: helperLabels,
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const unlabeled = {
  Id: "unlabeled-1",
  Names: ["/lando-test-data-22222222-2222-4222-8222-222222222222"],
  State: "exited",
  Labels: {},
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const foreign = {
  Id: "foreign-1",
  Names: ["/manual-db"],
  State: "running",
  Labels: {},
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const otherApp = {
  Id: "other-app",
  Names: ["/lando-test-data-other-app"],
  State: "exited",
  Labels: {
    "dev.lando.role": "data-helper",
    "dev.lando.app": "other-app",
    "dev.lando.provider": "test",
    "dev.lando.store": "data",
  },
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const otherProvider = {
  Id: "other-provider",
  Names: ["/lando-docker-data-other-provider"],
  State: "exited",
  Labels: {
    "dev.lando.role": "data-helper",
    "dev.lando.app": "app-id",
    "dev.lando.provider": "docker",
    "dev.lando.store": "data",
  },
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const noRole = {
  Id: "no-role",
  Names: ["/lando-test-data-no-role"],
  State: "exited",
  Labels: {
    "dev.lando.app": "app-id",
    "dev.lando.provider": "test",
    "dev.lando.store": "data",
  },
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const prefixMount = {
  Id: "prefix-mount",
  Names: ["/lando-test-data-prefix"],
  State: "exited",
  Labels: {},
  Mounts: [{ Type: "volume", Name: "data-extra", Source: "data-extra" }],
};

const emptyMounts = {
  Id: "empty-mounts",
  Names: ["/lando-test-data-empty"],
  State: "exited",
  Labels: {},
  Mounts: [],
};

const runningHelper = {
  Id: "running-1",
  Names: ["/lando-test-data-running"],
  State: "running",
  Labels: helperLabels,
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

type Listed = {
  readonly Id: string;
  readonly Names: ReadonlyArray<string>;
  readonly State: string;
  readonly Labels: Readonly<Record<string, string>>;
  readonly Mounts: ReadonlyArray<{ readonly Type?: string; readonly Name: string; readonly Source?: string }>;
};

const makeApi = (containers: Array<Listed>, options: { readonly honorFilters?: boolean } = {}) => {
  const honorFilters = options.honorFilters === true;
  const removed: string[] = [];
  const calls: string[] = [];
  const request = (input: HelperHttpRequest): Effect.Effect<HelperHttpResponse, never> =>
    Effect.sync(() => {
      calls.push(`${input.method} ${input.path}`);
      if (input.method === "GET" && input.path.startsWith("/containers/json?")) {
        if (!honorFilters) return { status: 200, body: JSON.stringify(containers) };
        const query = new URL(`http://localhost${input.path}`).searchParams.get("filters");
        const filters =
          query === null
            ? {}
            : (JSON.parse(decodeURIComponent(query)) as Record<string, ReadonlyArray<string>>);
        const labels = filters.label ?? [];
        const volumes = filters.volume ?? [];
        const listed = containers.filter((container) => {
          if (labels.length > 0) {
            return labels.every((criterion) => {
              const eq = criterion.indexOf("=");
              return (
                container.Labels[criterion.slice(0, eq) as keyof typeof container.Labels] ===
                criterion.slice(eq + 1)
              );
            });
          }
          if (volumes.length > 0) {
            return container.Mounts.some((mount) => volumes.includes(mount.Name));
          }
          return true;
        });
        return { status: 200, body: JSON.stringify(listed) };
      }
      if (input.method === "GET" && input.path.startsWith("/containers/") && input.path.endsWith("/json")) {
        const id = decodeURIComponent(input.path.slice("/containers/".length, -"/json".length));
        const container = containers.find((candidate) => candidate.Id === id);
        return {
          status: container === undefined ? 404 : 200,
          body: JSON.stringify(container ?? {}),
        };
      }
      if (input.method === "DELETE" && input.path.startsWith("/containers/")) {
        const id = decodeURIComponent(input.path.slice("/containers/".length, input.path.indexOf("?")));
        const index = containers.findIndex((candidate) => candidate.Id === id);
        if (index === -1) return { status: 404, body: "" };
        removed.push(containers[index]?.Names[0] ?? id);
        containers.splice(index, 1);
        return { status: 204, body: "" };
      }
      return { status: 500, body: `unexpected ${input.method} ${input.path}` };
    });
  return { request, removed, containers, calls };
};

describe("ephemeral data helpers", () => {
  test("pins the leftover helper name prefix and labels", () => {
    expect(ephemeralDataHelperNamePrefix("test")).toBe("lando-test-data-");
    expect(isEphemeralDataHelperName("lando-test-data-aaaa", "test")).toBe(true);
    expect(isEphemeralDataHelperName("manual-db", "test")).toBe(false);
    expect(ephemeralDataHelperLabels({ providerId: "test", app: "app-id", store: "data" })).toEqual({
      "dev.lando.role": "data-helper",
      "dev.lando.provider": "test",
      "dev.lando.app": "app-id",
      "dev.lando.store": "data",
    });
  });

  test("volume-in-use remediations names helpers and service containers differently", () => {
    expect(isVolumeInUse({ status: 409, body: "volume is in use" })).toBe(true);
    expect(volumeInUseRemediation([{ name: "lando-test-data-aaaa", kind: "data-helper" }])).toContain(
      "leftover data helper",
    );
    expect(volumeInUseRemediation([{ name: "manual-db", kind: "container" }])).toContain(
      "Stop or remove that container",
    );
    expect(volumeInUseRemediation([{ name: "manual-db", kind: "container" }])).not.toContain(
      "leftover data helper",
    );
    expect(volumeInUseRemediation([{ name: "manual-db", kind: "container" }])).not.toContain("lando doctor");
  });

  test("force-removes labeled leftovers for this app", async () => {
    const fake = makeApi([helper, { ...foreign }]);
    const result = await Effect.runPromise(
      removeEphemeralDataHelpers(fake.request, { appId: "app-id", providerId: "test" }),
    );
    expect(result.removed).toEqual(["lando-test-data-11111111-1111-4111-8111-111111111111"]);
    expect(fake.containers.map((container) => container.Id)).toEqual(["foreign-1"]);
  });

  test("safety filters keep another app, another provider, and a container without the role", async () => {
    const fake = makeApi([otherApp, otherProvider, noRole, helper]);
    const result = await Effect.runPromise(
      removeEphemeralDataHelpers(fake.request, { appId: "app-id", providerId: "test" }),
    );
    expect(result.removed).toEqual(["lando-test-data-11111111-1111-4111-8111-111111111111"]);
    expect(fake.containers.map((container) => container.Id)).toEqual([
      "other-app",
      "other-provider",
      "no-role",
    ]);
  });

  test("unlabeled backstop removes only name-matched helpers that mount this volume exactly", async () => {
    const fake = makeApi([unlabeled, prefixMount, emptyMounts, foreign]);
    const result = await Effect.runPromise(
      removeUnlabeledEphemeralDataHolders(fake.request, { providerId: "test", volumeName: "data" }),
    );
    expect(result.removed).toEqual(["lando-test-data-22222222-2222-4222-8222-222222222222"]);
    expect(result.remaining.map((holder) => holder.name)).toEqual([
      "lando-test-data-prefix",
      "lando-test-data-empty",
      "manual-db",
    ]);
    expect(fake.containers.map((container) => container.Id)).toEqual([
      "prefix-mount",
      "empty-mounts",
      "foreign-1",
    ]);
  });

  test("does not force-remove a running helper", async () => {
    const fake = makeApi([runningHelper]);
    const result = await Effect.runPromise(
      removeEphemeralDataHelpers(fake.request, { appId: "app-id", providerId: "test" }),
    );
    expect(result.removed).toEqual([]);
    expect(result.remaining.map((holder) => holder.name)).toEqual(["lando-test-data-running"]);
    expect(fake.removed).toEqual([]);
  });

  test("held-volume sweep removes labeled leftovers before callers delete the volume", async () => {
    const fake = makeApi([helper]);
    const remaining = await Effect.runPromise(
      releaseVolumeHolders(fake.request, { appId: "app-id", providerId: "test", volumeName: "data" }),
    );
    expect(remaining).toEqual([]);
    expect(fake.removed).toEqual(["/lando-test-data-11111111-1111-4111-8111-111111111111"]);
    const helperDelete = fake.calls.findIndex((call) => call.startsWith("DELETE /containers/"));
    expect(helperDelete).toBeGreaterThanOrEqual(0);
  });

  test("fail-clearly names a foreign holder that still mounts the volume", async () => {
    const fake = makeApi([foreign]);
    const remaining = await Effect.runPromise(
      releaseVolumeHolders(fake.request, { appId: "app-id", providerId: "test", volumeName: "data" }),
    );
    expect(remaining.map((holder) => holder.name)).toEqual(["manual-db"]);
    expect(classifyVolumeHolder(remaining[0] as VolumeHolder, "test")).toBe("container");
    expect(volumeInUseRemediation(namedHolders(remaining, "test"))).toContain("manual-db");
    expect(volumeInUseRemediation(namedHolders(remaining, "test"))).toContain(
      "Stop or remove that container",
    );
    expect(fake.removed).toEqual([]);
  });

  test("a list error skips cleanup instead of failing the caller", async () => {
    const request = () => Effect.fail(new Error("list exploded"));
    const remaining = await Effect.runPromise(
      releaseVolumeHolders(request, { appId: "app-id", providerId: "test", volumeName: "data" }),
    );
    expect(remaining).toEqual([]);
  });
});
