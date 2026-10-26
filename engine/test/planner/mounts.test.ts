import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  type AppPlan,
  LandofileShape,
  MountPlan,
  ServiceName,
  bindSyncIgnores,
  plannedFileSyncSessions,
  serviceAppMount,
} from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const plan = async (service: Record<string, unknown>, accelerated = false): Promise<AppPlan> => {
  const root = await mkdtemp(join(tmpdir(), "lando-mount-list-"));
  try {
    const document = Schema.decodeUnknownSync(LandofileShape)({
      name: "mountapp",
      runtime: 4,
      services: { web: { type: "node:22", home: false, ...service } },
    });
    const layer = AppPlannerLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          PluginRegistryLayer.layer,
          BunFileSystem.layer,
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: root, env: {} })),
        ),
      ),
    );
    return await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(literalTestLandofile(document, root), {
          ...TestRuntimeProvider.capabilities,
          bindMountPerformance: accelerated ? "slow" : "native",
        }),
      ).pipe(Effect.provide(layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const web = (app: AppPlan) => {
  const service = app.services[ServiceName.make("web")];
  if (service === undefined) throw new Error("Planner omitted web service");
  return service;
};

/** The planned list in wire form, so expectations can use plain target strings. */
const wireMounts = (app: AppPlan): ReadonlyArray<typeof MountPlan.Encoded> =>
  Schema.encodeSync(Schema.Array(MountPlan))(web(app).mounts);

test("nested authored bind coexists with its parent shadow", async () => {
  const app = await plan({ mounts: ["./vendor/acme/sdk:/app/vendor/acme/sdk"] });
  const mounts = web(app).mounts;
  expect(mounts.find((mount) => mount.target === "/app/vendor")?.type).toBe("volume");
  expect(mounts.find((mount) => mount.target === "/app/vendor/acme/sdk")).toMatchObject({
    type: "bind",
    source: join(app.root, "vendor/acme/sdk"),
    realization: "passthrough",
  });
});

test("nested includes reopen their own shadow", async () => {
  const app = await plan({ appMount: { target: "/app", includes: ["vendor/acme/sdk"] } });
  expect(web(app).mounts.find((mount) => mount.target === "/app/vendor/acme/sdk")).toMatchObject({
    type: "bind",
    source: join(app.root, "vendor/acme/sdk"),
    readOnly: false,
    realization: "passthrough",
  });
});

test("includes never cross an intervening authored mount", async () => {
  const app = await plan({
    appMount: { target: "/app", includes: ["vendor/acme/sdk"] },
    mounts: ["./other:/app/vendor/acme"],
  });
  expect(web(app).mounts.some((mount) => mount.target === "/app/vendor/acme/sdk")).toBe(false);
});

test.each(["/absolute", "../outside", "vendor/../outside", "vendor/*", "vendor/?", "vendor/[a]"])(
  "rejects nonliteral include %s",
  async (include) => {
    await expect(plan({ appMount: { target: "/app", includes: [include] } })).rejects.toMatchObject({
      _tag: "LandofileValidationError",
    });
  },
);

test("authored bind at the exclude target replaces its shadow", async () => {
  const app = await plan({ mounts: ["./alternate:/app/vendor"] });
  expect(web(app).mounts.filter((mount) => mount.target === "/app/vendor")).toMatchObject([
    { type: "bind", source: join(app.root, "alternate") },
  ]);
  expect(app.stores.some((store) => store.name.includes("app-vendor-"))).toBe(false);
});

test("authored tmpfs replaces a shadow and contributes a sync ignore", async () => {
  const app = await plan({ mounts: [{ type: "tmpfs", target: "/app/node_modules" }] }, true);
  const service = web(app);
  const bind = serviceAppMount(service);
  expect(wireMounts(app).filter((mount) => mount.target === "/app/node_modules")).toEqual([
    { type: "tmpfs", target: "/app/node_modules", readOnly: false },
  ]);
  expect(bind === undefined ? [] : bindSyncIgnores(service, bind)).toContain("node_modules");
});

test("authored storage and excludes produce equivalent mount targets and sync ignores", async () => {
  const excluded = web(await plan({ appMount: { target: "/app", excludes: ["vendor"] } }, true));
  const stored = web(await plan({ storage: ["/app/vendor"] }, true));
  expect(stored.mounts.map(({ type, target }) => ({ type, target }))).toEqual(
    excluded.mounts.map(({ type, target }) => ({ type, target })),
  );
  expect(plannedFileSyncSessions({ name: "mountapp", services: { web: stored } })?.[0]?.excludes).toEqual(
    plannedFileSyncSessions({ name: "mountapp", services: { web: excluded } })?.[0]?.excludes,
  );
});

test("every authored bind can create exclude shadows", async () => {
  const app = await plan({
    appMount: false,
    mounts: [{ source: "./packages", target: "/packages", excludes: ["vendor"], includes: ["vendor/sdk"] }],
  });
  expect(wireMounts(app)).toEqual([
    {
      type: "bind",
      source: join(app.root, "packages"),
      target: "/packages",
      readOnly: false,
      excludes: ["vendor"],
      includes: ["vendor/sdk"],
      realization: "passthrough",
    },
    { type: "volume", store: expect.any(String), target: "/packages/vendor", readOnly: false },
    {
      type: "bind",
      source: join(app.root, "packages/vendor/sdk"),
      target: "/packages/vendor/sdk",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});

test("volumes on mariadb compile both bind and tmpfs entries", async () => {
  const app = await plan({
    type: "mariadb",
    volumes: [
      "./config:/etc/custom",
      { type: "tmpfs", target: "/scratch", tmpfs: { size: "64m", mode: 1023 } },
    ],
  });
  expect(wireMounts(app)).toContainEqual({
    type: "tmpfs",
    target: "/scratch",
    readOnly: false,
    options: "size=64m,mode=1777",
  });
  expect(web(app).mounts.find((mount) => mount.target === "/etc/custom")).toMatchObject({
    type: "bind",
    source: join(app.root, "config"),
  });
});

test("two Lando spellings at a canonical target fail with both issue paths", async () => {
  await expect(plan({ mounts: ["./x:/app/vendor/"], storage: ["/app/vendor"] })).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    issues: [
      expect.objectContaining({ path: ["services", "web", "storage", 0] }),
      expect.objectContaining({ path: ["services", "web", "mounts", 0] }),
    ],
  });
});

test("mounts take precedence over Compose volumes", async () => {
  const app = await plan({ mounts: ["./winner:/data"], volumes: ["./loser:/data/"] });
  expect(web(app).mounts.filter((mount) => mount.target === "/data")).toMatchObject([
    { type: "bind", source: join(app.root, "winner") },
  ]);
});

test("named mounts volumes register an owned store", async () => {
  const app = await plan({ mounts: [{ type: "volume", source: "named", target: "/named" }] });
  expect(wireMounts(app)).toContainEqual({
    type: "volume",
    store: "mountapp-named",
    target: "/named",
    readOnly: false,
  });
  expect(app.stores).toContainEqual({ name: "mountapp-named", scope: "service", kind: "data" });
});

test("authored bind replaces type data volume and removes its ownership tree", async () => {
  const app = await plan({ type: "mariadb", mounts: ["./db:/var/lib/mysql"] });
  expect(web(app).mounts.filter((mount) => mount.target === "/var/lib/mysql")).toMatchObject([
    { type: "bind" },
  ]);
  expect(web(app).extensions["@lando/core/service-features"]).toMatchObject({ dataTrees: [] });
});

test("service tmpfs normalizes access tokens and preserves runtime options", async () => {
  const app = await plan({ tmpfs: ["/run/x:size=8m,ro", "/run/y:rw,noexec"] });
  expect(wireMounts(app)).toContainEqual({
    type: "tmpfs",
    target: "/run/x",
    readOnly: true,
    options: "size=8m",
  });
  expect(wireMounts(app)).toContainEqual({
    type: "tmpfs",
    target: "/run/y",
    readOnly: false,
    options: "noexec",
  });
});

test("conflicting tmpfs access modes fail", async () => {
  await expect(plan({ tmpfs: ["/run/x:ro,rw"] })).rejects.toMatchObject({ _tag: "LandofileValidationError" });
});

test("mount order and identity keys do not depend on authored order", async () => {
  const entries = ["./z:/app/deep/z", "./a:/aaa"];
  const first = await plan({ mounts: entries }, true);
  const second = await plan({ mounts: [...entries].reverse() }, true);
  const service = web(first);
  expect(wireMounts(first).map(({ target }) => target)).toEqual([
    "/aaa",
    "/app",
    "/app/node_modules",
    "/app/tmp",
    "/app/vendor",
    "/app/deep/z",
  ]);
  expect(serviceAppMount(service)).toMatchObject({ realization: "accelerated", mountKey: "app-mount" });
  expect(
    service.mounts
      .filter((mount) => mount.type === "bind")
      .map(({ target, mountKey }) => ({ target, mountKey })),
  ).toEqual(
    web(second)
      .mounts.filter((mount) => mount.type === "bind")
      .map(({ target, mountKey }) => ({ target, mountKey })),
  );
  const expected = plannedFileSyncSessions(first)?.[0];
  expect(first.fileSync[0]?.session).toMatchObject({
    service: "web",
    mountKey: "app-mount",
    source: expected?.source,
    target: { _tag: "volume", name: expected?.volumeName, path: expected?.targetPath },
    excludes: expected?.excludes,
  });
});

test("a cache declared through a noncanonical path stays a global cache store", async () => {
  const app = await plan({ storage: [{ store: "ignored", target: "/app/cache/../deps", kind: "cache" }] });
  expect(wireMounts(app)).toContainEqual({
    type: "volume",
    store: "lando-cache-app-deps",
    target: "/app/deps",
    readOnly: false,
  });
  expect(app.stores).toContainEqual({
    name: "lando-cache-app-deps",
    scope: "global",
    kind: "cache",
    key: "app-deps",
  });
});
