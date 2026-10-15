import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  ephemeralDataHelperLabels,
  ephemeralDataHelperNamePrefix,
  isEphemeralDataHelperName,
  isVolumeInUse,
  releaseVolumeHolders,
  removeEphemeralDataHelpers,
  removeUnlabeledEphemeralDataHolders,
  volumeInUseRemediation,
} from "../src/ephemeral-data-helpers.ts";
import type { HelperHttpRequest, HelperHttpResponse } from "../src/ephemeral-data-helpers.ts";

const helper = {
  Id: "helper-1",
  Names: ["/lando-test-data-11111111-1111-4111-8111-111111111111"],
  Labels: {
    "dev.lando.role": "ephemeral=data",
    "dev.lando.app": "app-id",
    "dev.lando.provider": "test",
    "dev.lando.store": "data",
  },
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const unlabeled = {
  Id: "unlabeled-1",
  Names: ["/lando-test-data-22222222-2222-4222-8222-222222222222"],
  Labels: {},
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const foreign = {
  Id: "foreign-1",
  Names: ["/manual-db"],
  Labels: {},
  Mounts: [{ Type: "volume", Name: "data", Source: "data" }],
};

const otherApp = {
  Id: "other-1",
  Names: ["/lando-test-data-33333333-3333-4333-8333-333333333333"],
  Labels: {},
  Mounts: [{ Type: "volume", Name: "other", Source: "other" }],
};

const filtersOf = (path: string): Readonly<Record<string, ReadonlyArray<string>>> => {
  const query = new URL(`http://localhost${path}`).searchParams.get("filters");
  return query === null ? {} : (JSON.parse(decodeURIComponent(query)) as Record<string, ReadonlyArray<string>>);
};

const makeApi = (containers: Array<typeof helper>) => {
  const removed: string[] = [];
  const request = (input: HelperHttpRequest): Effect.Effect<HelperHttpResponse, never> =>
    Effect.sync(() => {
      if (input.method === "GET" && input.path.startsWith("/containers/json?")) {
        const filters = filtersOf(input.path);
        const labels = filters.label ?? [];
        const volumes = filters.volume ?? [];
        const listed = containers.filter((container) => {
          if (labels.length > 0) {
            return labels.every((criterion) => {
              const eq = criterion.indexOf("=");
              const key = criterion.slice(0, eq);
              const value = criterion.slice(eq + 1);
              return container.Labels[key as keyof typeof container.Labels] === value;
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
  return { request, removed, containers };
};

describe("ephemeral data helpers", () => {
  test("pins the leftover helper name prefix and labels", () => {
    expect(ephemeralDataHelperNamePrefix("test")).toBe("lando-test-data-");
    expect(isEphemeralDataHelperName("lando-test-data-aaaa", "test")).toBe(true);
    expect(isEphemeralDataHelperName("manual-db", "test")).toBe(false);
    expect(ephemeralDataHelperLabels({ providerId: "test", app: "app-id", store: "data" })).toEqual({
      "dev.lando.role": "ephemeral=data",
      "dev.lando.provider": "test",
      "dev.lando.app": "app-id",
      "dev.lando.store": "data",
    });
  });

  test("volume-in-use remediations names the holder and does not claim doctor lists leftovers", () => {
    expect(isVolumeInUse({ status: 409, body: "volume is in use" })).toBe(true);
    const remediations = volumeInUseRemediation(["lando-test-data-aaaa"]);
    expect(remediations).toContain("lando-test-data-aaaa");
    expect(remediations).toContain("lando destroy --volumes");
    expect(remediations).toContain("cannot see these helpers");
    expect(remediations).not.toContain("lists leftovers");
  });

  test("force-removes labeled leftovers for this app", async () => {
    const fake = makeApi([helper, { ...foreign }]);
    const removed = await Effect.runPromise(
      removeEphemeralDataHelpers(fake.request, { appId: "app-id", providerId: "test" }),
    );
    expect(removed).toEqual(["lando-test-data-11111111-1111-4111-8111-111111111111"]);
    expect(fake.containers.map((container) => container.Id)).toEqual(["foreign-1"]);
  });

  test("unlabeled backstop removes only name-matched helpers that mount this volume", async () => {
    const fake = makeApi([unlabeled, otherApp, foreign]);
    const result = await Effect.runPromise(
      removeUnlabeledEphemeralDataHolders(fake.request, { providerId: "test", volumeName: "data" }),
    );
    expect(result.removed).toEqual(["lando-test-data-22222222-2222-4222-8222-222222222222"]);
    expect(result.remaining.map((holder) => holder.name)).toEqual(["manual-db"]);
    expect(fake.containers.map((container) => container.Id)).toEqual(["other-1", "foreign-1"]);
  });

  test("held-volume sweep removes labeled leftovers before callers delete the volume", async () => {
    const fake = makeApi([helper]);
    const remaining = await Effect.runPromise(
      releaseVolumeHolders(fake.request, { appId: "app-id", providerId: "test", volumeName: "data" }),
    );
    expect(remaining).toEqual([]);
    expect(fake.removed).toEqual(["lando-test-data-11111111-1111-4111-8111-111111111111"]);
  });

  test("fail-clearly names a foreign holder that still mounts the volume", async () => {
    const fake = makeApi([foreign]);
    const remaining = await Effect.runPromise(
      releaseVolumeHolders(fake.request, { appId: "app-id", providerId: "test", volumeName: "data" }),
    );
    expect(remaining.map((holder) => holder.name)).toEqual(["manual-db"]);
    expect(volumeInUseRemediation(remaining.map((holder) => holder.name))).toContain("manual-db");
    expect(fake.removed).toEqual([]);
  });
});
