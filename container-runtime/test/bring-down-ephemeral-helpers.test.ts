import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { dockerLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { volumeOwnershipLabels } from "../src/volume-ownership.ts";

const appId = AppId.make("app-id");
const providerId = ProviderId.make("test");
const appRoot = AbsolutePath.make("/tmp/app");
const dataStore = { name: "data", scope: "app", kind: "data" } as const;
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
  stores: [dataStore],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-06-30T00:00:00Z"),
    source: "bring-down ephemeral helper test",
    runtime: 4,
  },
  extensions: {},
} satisfies AppPlan;

const volumeLabels = volumeOwnershipLabels(plan, dataStore);

const makeApi = (input: {
  readonly helpers: Array<{
    readonly Id: string;
    readonly Names: ReadonlyArray<string>;
    readonly State?: string;
    readonly Labels: Readonly<Record<string, string>>;
    readonly Mounts: ReadonlyArray<{ readonly Name: string }>;
  }>;
  readonly holdUntilRemoved?: boolean;
  readonly honorFilters?: boolean;
}) => {
  const helpers = [...input.helpers];
  const removed: string[] = [];
  const calls: string[] = [];
  const honorFilters = input.honorFilters === true;
  const request = (request: EngineHttpRequest): Effect.Effect<EngineHttpResponse, never> =>
    Effect.sync(() => {
      calls.push(`${request.method} ${request.path}`);
      if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
        return { status: 204, body: "" };
      }
      if (request.method === "GET" && request.path === "/volumes/data") {
        return { status: 200, body: JSON.stringify({ Labels: volumeLabels }) };
      }
      if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
        if (!honorFilters) return { status: 200, body: JSON.stringify(helpers) };
        const query = new URL(`http://localhost${request.path}`).searchParams.get("filters");
        const filters =
          query === null
            ? {}
            : (JSON.parse(decodeURIComponent(query)) as Record<string, ReadonlyArray<string>>);
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
  return { request, removed, helpers, calls };
};

const down = (api: { request: typeof makeApi extends (...args: never) => infer R ? R["request"] : never }) =>
  bringDown(plan, {
    api,
    ctx: { providerId: "test", remediation: "retry" },
    volumes: true,
    dialect: dockerLifecycleDialect,
  });

const labeledHelper = (
  overrides: {
    readonly Id?: string;
    readonly Names?: ReadonlyArray<string>;
    readonly State?: string;
    readonly Labels?: Readonly<Record<string, string>>;
    readonly Mounts?: ReadonlyArray<{ readonly Name: string }>;
  } = {},
) => ({
  Id: "helper-1",
  Names: ["/lando-test-data-aaaa"],
  State: "exited",
  Labels: {
    "dev.lando.role": "data-helper",
    "dev.lando.app": "app-id",
    "dev.lando.provider": "test",
    "dev.lando.store": "data",
  },
  Mounts: [{ Name: "data" }],
  ...overrides,
});

describe("bringDown leftover data helpers", () => {
  test("destroys a held volume after sweeping a labeled leftover helper", async () => {
    const fake = makeApi({
      holdUntilRemoved: true,
      helpers: [labeledHelper()],
    });

    const result = await Effect.runPromise(down(fake));

    expect(result.changed).toBe(true);
    expect(fake.removed).toEqual(["/lando-test-data-aaaa"]);
    expect(fake.helpers).toEqual([]);
  });

  test("deletes the leftover helper before inspecting or deleting the volume", async () => {
    const fake = makeApi({
      holdUntilRemoved: true,
      helpers: [labeledHelper()],
    });

    await Effect.runPromise(down(fake));

    const helperList = fake.calls.findIndex(
      (call) => call.startsWith("GET /containers/json?") && call.includes("dev.lando.role"),
    );
    const helperDelete = fake.calls.findIndex((call) => call.startsWith("DELETE /containers/"));
    const volumeInspect = fake.calls.findIndex((call) => call === "GET /volumes/data");
    const volumeDelete = fake.calls.findIndex((call) => call === "DELETE /volumes/data");
    expect(helperList).toBeGreaterThanOrEqual(0);
    expect(helperDelete).toBeGreaterThan(helperList);
    expect(volumeInspect).toBeGreaterThan(helperDelete);
    expect(volumeDelete).toBeGreaterThan(volumeInspect);
  });

  test("unlabeled backstop removes a leftover helper that mounts this app volume", async () => {
    const fake = makeApi({
      holdUntilRemoved: true,
      helpers: [
        {
          Id: "helper-2",
          Names: ["/lando-test-data-bbbb"],
          State: "exited",
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
          State: "running",
          Labels: {},
          Mounts: [{ Name: "data" }],
        },
      ],
    });

    const error = await Effect.runPromise(down(fake).pipe(Effect.flip));

    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.message).toContain("manual-db");
    expect(error.remediation).toContain("manual-db");
    expect(error.remediation).toContain("Stop or remove that container");
    expect(error.remediation).not.toContain("leftover data helper");
    expect(error.remediation).not.toContain("lando doctor");
    expect(fake.removed).toEqual([]);
  });

  test("does not kill a running data helper and names it as the holder", async () => {
    const fake = makeApi({
      holdUntilRemoved: true,
      helpers: [labeledHelper({ Id: "running-1", Names: ["/lando-test-data-running"], State: "running" })],
    });

    const error = await Effect.runPromise(down(fake).pipe(Effect.flip));

    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.message).toContain("lando-test-data-running");
    expect(error.remediation).toContain("lando-test-data-running");
    expect(error.remediation).toContain("leftover data helper");
    expect(fake.removed).toEqual([]);
  });

  test("safety filters keep another app, another provider, a container without the role, a prefix mount, and an empty mount", async () => {
    const fake = makeApi({
      holdUntilRemoved: true,
      helpers: [
        labeledHelper({
          Id: "other-app",
          Names: ["/lando-test-data-other-app"],
          Labels: {
            "dev.lando.role": "data-helper",
            "dev.lando.app": "other-app",
            "dev.lando.provider": "test",
            "dev.lando.store": "data",
          },
        }),
        labeledHelper({
          Id: "other-provider",
          Names: ["/lando-test-data-other-provider"],
          Labels: {
            "dev.lando.role": "data-helper",
            "dev.lando.app": "app-id",
            "dev.lando.provider": "docker",
            "dev.lando.store": "data",
          },
        }),
        labeledHelper({
          Id: "no-role",
          Names: ["/lando-myapp-web"],
          Labels: {
            "dev.lando.app": "app-id",
            "dev.lando.provider": "test",
            "dev.lando.service": "web",
          },
        }),
        {
          Id: "prefix-mount",
          Names: ["/lando-test-data-prefix"],
          State: "exited",
          Labels: {},
          Mounts: [{ Name: "data-extra" }],
        },
        {
          Id: "empty-mounts",
          Names: ["/lando-test-data-empty"],
          State: "exited",
          Labels: {},
          Mounts: [],
        },
      ],
    });

    const error = await Effect.runPromise(down(fake).pipe(Effect.flip));

    expect(error._tag).toBe("ProviderUnavailableError");
    expect(fake.removed).toEqual([]);
    expect(fake.helpers.map((helper) => helper.Id)).toEqual([
      "other-app",
      "other-provider",
      "no-role",
      "prefix-mount",
      "empty-mounts",
    ]);
  });
});
