import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { dockerLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { volumeOwnershipLabels } from "../src/volume-ownership.ts";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";

const appId = AppId.make("app-id");
const providerId = ProviderId.make("test");
const appRoot = AbsolutePath.make("/tmp/app");
const plan = {
  id: appId,
  name: "App",
  slug: "app",
  root: appRoot,
  provider: providerId,
  identity: { appRoot, ownerKey: "owner:/tmp/app" },
  services: {},
  routes: [],
  networks: [],
  stores: [{ name: "data", scope: "app", kind: "data" }],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-06-30T00:00:00Z"),
    source: "bring-down ephemeral helper test",
    runtime: 4,
  },
  extensions: {},
} satisfies AppPlan;

const volumeLabels = volumeOwnershipLabels(plan, plan.stores[0]!);

const filtersOf = (path: string): Readonly<Record<string, ReadonlyArray<string>>> => {
  const query = new URL(`http://localhost${path}`).searchParams.get("filters");
  return query === null ? {} : (JSON.parse(decodeURIComponent(query)) as Record<string, ReadonlyArray<string>>);
};

const makeApi = (input: {
  readonly helpers: Array<{
    readonly Id: string;
    readonly Names: ReadonlyArray<string>;
    readonly Labels: Readonly<Record<string, string>>;
    readonly Mounts: ReadonlyArray<{ readonly Name: string }>;
  }>;
  readonly holdUntilRemoved?: boolean;
}) => {
  const helpers = [...input.helpers];
  const removed: string[] = [];
  const request = (request: EngineHttpRequest): Effect.Effect<EngineHttpResponse, never> =>
    Effect.sync(() => {
      if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
        return { status: 204, body: "" };
      }
      if (request.method === "GET" && request.path === "/volumes/data") {
        return { status: 200, body: JSON.stringify({ Labels: volumeLabels }) };
      }
      if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
        const filters = filtersOf(request.path);
        const labels = filters.label ?? [];
        const volumes = filters.volume ?? [];
        const listed = helpers.filter((container) => {
          if (labels.length > 0) {
            return labels.every((criterion) => {
              const eq = criterion.indexOf("=");
              return container.Labels[criterion.slice(0, eq)] === criterion.slice(eq + 1);
            });
          }
          return volumes.length === 0 || container.Mounts.some((mount) => volumes.includes(mount.Name));
        });
        return { status: 200, body: JSON.stringify(listed) };
      }
      if (request.method === "DELETE" && request.path.startsWith("/containers/")) {
        const id = decodeURIComponent(request.path.slice("/containers/".length, request.path.indexOf("?")));
        const index = helpers.findIndex((helper) => helper.Id === id);
        if (index === -1) return { status: 404, body: "" };
        removed.push(helpers[index]?.Names[0] ?? id);
        helpers.splice(index, 1);
        return { status: 204, body: "" };
      }
      if (request.method === "DELETE" && request.path === "/volumes/data") {
        if (input.holdUntilRemoved === true && helpers.length > 0) {
          return {
            status: 409,
            body: JSON.stringify({ message: `volume data is in use by ${helpers[0]?.Names[0]}` }),
          };
        }
        return { status: 204, body: "" };
      }
      return { status: 500, body: `unexpected ${request.method} ${request.path}` };
    });
  return { request, removed, helpers };
};

const down = (api: { request: typeof makeApi extends (...args: never) => infer R ? R["request"] : never }) =>
  bringDown(plan, {
    api,
    ctx: { providerId: "test", remediation: "retry" },
    volumes: true,
    dialect: dockerLifecycleDialect,
  });

describe("bringDown leftover data helpers", () => {
  test("destroys a held volume after sweeping a labeled leftover helper", async () => {
    const fake = makeApi({
      holdUntilRemoved: true,
      helpers: [
        {
          Id: "helper-1",
          Names: ["/lando-test-data-aaaa"],
          Labels: {
            "dev.lando.role": "ephemeral=data",
            "dev.lando.app": "app-id",
            "dev.lando.provider": "test",
            "dev.lando.store": "data",
          },
          Mounts: [{ Name: "data" }],
        },
      ],
    });

    const result = await Effect.runPromise(down(fake));

    expect(result.changed).toBe(true);
    expect(fake.removed).toEqual(["/lando-test-data-aaaa"]);
    expect(fake.helpers).toEqual([]);
  });

  test("unlabeled backstop removes a leftover helper that mounts this app volume", async () => {
    const fake = makeApi({
      holdUntilRemoved: true,
      helpers: [
        {
          Id: "helper-2",
          Names: ["/lando-test-data-bbbb"],
          Labels: {},
          Mounts: [{ Name: "data" }],
        },
      ],
    });

    const result = await Effect.runPromise(down(fake));

    expect(result.changed).toBe(true);
    expect(fake.removed).toEqual(["/lando-test-data-bbbb"]);
  });

  test("fails clearly when a foreign unlabeled container still holds the volume", async () => {
    const fake = makeApi({
      holdUntilRemoved: true,
      helpers: [
        {
          Id: "foreign-1",
          Names: ["/manual-db"],
          Labels: {},
          Mounts: [{ Name: "data" }],
        },
      ],
    });

    const error = await Effect.runPromise(down(fake).pipe(Effect.flip));

    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.message).toContain("manual-db");
    expect(error.remediation).toContain("manual-db");
    expect(error.remediation).toContain("cannot see these helpers");
    expect(error.remediation).not.toContain("lists leftovers");
    expect(fake.removed).toEqual([]);
  });
});
