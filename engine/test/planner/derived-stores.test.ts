import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const plan = async (name: string, services: Record<string, unknown>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-derived-store-"));
  try {
    const document = Schema.decodeUnknownSync(LandofileShape)({ name, services });
    return await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(literalTestLandofile(document, root), TestRuntimeProvider.capabilities),
      ).pipe(Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer)))),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const compose = (fields: Record<string, unknown>) => ({
  type: "compose",
  image: "alpine:3.20",
  appMount: false,
  ...fields,
});

test("#2026 two unrelated apps using storage string shorthand get different volumes", async () => {
  const first = await plan("first", { web: compose({ storage: ["/data"] }) });
  const second = await plan("second", { web: compose({ storage: ["/data"] }) });
  expect(first.stores).toEqual([
    { name: "lando-first--web--storage--data-bd47413b", scope: "service", kind: "data" },
  ]);
  expect(second.stores).toEqual([
    { name: "lando-second--web--storage--data-bd47413b", scope: "service", kind: "data" },
  ]);
});

test.each(["mounts", "volumes"])(
  "%s without a source derives the same exact-target storage name",
  async (spelling) => {
    const app = await plan("app", {
      web: compose({
        [spelling]: [
          { type: "volume", target: "/data" },
          { type: "volume", target: "/foo/bar" },
          { type: "volume", target: "/foo-bar" },
        ],
      }),
    });
    expect(app.stores[0]).toEqual({
      name: "lando-app--web--storage--data-bd47413b",
      scope: "service",
      kind: "data",
    });
    expect(new Set(app.stores.map(({ name }) => name)).size).toBe(3);
  },
);

test("both Compose volume spellings compile app scope with their shared physical name", async () => {
  const app = await plan("app", {
    one: compose({ mounts: [{ type: "volume", source: "shared", target: "/data" }] }),
    two: compose({ volumes: ["shared:/elsewhere"] }),
  });
  expect(app.stores).toEqual([{ name: "lando-app_shared", scope: "app", kind: "data" }]);
  for (const service of ["one", "two"])
    expect(app.services[ServiceName.make(service)]?.mounts).toContainEqual(
      expect.objectContaining({ store: "lando-app_shared" }),
    );
});

test.each([
  [
    "scope",
    { store: "shared", target: "/a", scope: "service" },
    { store: "shared", target: "/b", scope: "app" },
    "shared",
  ],
  [
    "kind",
    { store: "ignored", target: "/a", kind: "cache", key: "npm" },
    { store: "lando-cache-npm", target: "/b" },
    "lando-cache-npm",
  ],
  [
    "key",
    { store: "shared", target: "/a", key: "first" },
    { store: "shared", target: "/b", key: "second" },
    "shared",
  ],
] as const)(
  "refuses conflicting %s metadata and identifies both services",
  async (_field, first, second, store) => {
    await expect(
      plan("app", { one: compose({ storage: [first] }), two: compose({ storage: [second] }) }),
    ).rejects.toMatchObject({
      _tag: "LandofileValidationError",
      message: expect.stringMatching(new RegExp(`Store ${store}.*one and two`, "u")),
    });
  },
);

test("explicit store names stay verbatim and matching metadata permits intentional sharing", async () => {
  const storage = [{ store: "lando-ssh-agent", target: "/agent", scope: "app" }];
  const app = await plan("app", { one: compose({ storage }), two: compose({ storage }) });
  expect(app.stores).toEqual([{ name: "lando-ssh-agent", scope: "app", kind: "data" }]);
});

test("rejects incompatible definitions within one service rather than keeping the last metadata", async () => {
  await expect(
    plan("app", {
      web: compose({
        storage: [
          { store: "shared", target: "/a", scope: "app" },
          { store: "shared", target: "/b" },
        ],
      }),
    }),
  ).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    message: expect.stringContaining("Store shared has conflicting definitions in service web"),
  });
});

test.each([
  ["home", { type: "node:22", user: "root", appMount: false }, "lando-app--web--home--root-3177abf4"],
  ["shadow", { type: "node:22", home: false }, "lando-app--web--shadow--app-vendor-64784057"],
  ["catalog", { type: "mariadb", home: false, appMount: false }, "lando-app--web--mariadb-data"],
] as const)(
  "rejects an explicit app-scoped store that reuses a service-scoped %s store",
  async (_kind, service, store) => {
    await expect(
      plan("app", { web: { ...service, storage: [{ store, target: "/copy", scope: "app" }] } }),
    ).rejects.toMatchObject({
      _tag: "LandofileValidationError",
      message: expect.stringContaining(`Store ${store} has conflicting`),
    });
  },
);
