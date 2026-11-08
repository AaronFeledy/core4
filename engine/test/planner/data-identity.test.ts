import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { resolveAppIdentity } from "../../src/planner/app-identity.ts";
import {
  appDataIdentityBucketSpec,
  clearAppDataIdentity,
  readAppDataIdentity,
  recordAppDataIdentity,
} from "../../src/planner/data-identity.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

test("record keeps the first name and clear removes the file", async () => {
  const store = makeTestStateStore();
  const root = await mkdtemp(join(tmpdir(), "lando-data-record-"));
  try {
    const identity = await Effect.runPromise(resolveAppIdentity(root));
    await Effect.runPromise(recordAppDataIdentity(identity, "original").pipe(Effect.provide(store.layer)));
    await Effect.runPromise(recordAppDataIdentity(identity, "renamed").pipe(Effect.provide(store.layer)));
    expect(await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer)))).toEqual({
      name: "original",
    });

    await Effect.runPromise(clearAppDataIdentity(identity).pipe(Effect.provide(store.layer)));

    expect(store.snapshot().size).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renaming retains every derived store and database credential while runtime names change", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-data-plan-"));
  const store = makeTestStateStore();
  const layer = AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.merge(PluginRegistryLayer.layer, store.layer)),
  );
  const services = {
    database: { type: "mariadb" },
    web: { type: "node:22", user: "root", storage: ["/extra"] },
  };
  const plan = (name: string, extra = {}) =>
    Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(
          literalTestLandofile(
            Schema.decodeUnknownSync(LandofileShape)({ name, services: { ...services, ...extra } }),
            root,
          ),
          TestRuntimeProvider.capabilities,
        ),
      ).pipe(Effect.provide(layer)),
    );
  try {
    const before = await plan("original");
    const identity = await Effect.runPromise(resolveAppIdentity(root));
    await Effect.runPromise(recordAppDataIdentity(identity, "original").pipe(Effect.provide(store.layer)));

    const after = await plan("renamed");

    expect(after.stores).toEqual(before.stores);
    expect(after.services[ServiceName.make("database")]?.connection?.creds).toEqual(
      before.services[ServiceName.make("database")]?.connection?.creds,
    );
    expect(after.services[ServiceName.make("database")]?.connection?.creds.database).toBe("original");
    expect(after.slug).toBe("renamed");
    expect(after.identity?.dataName).toBe("original");
    expect(after.services[ServiceName.make("web")]?.environment.LANDO_APP_NAME).toBe("renamed");
    expect(after.services[ServiceName.make("web")]?.environment.LANDO_PROJECT).toBe("renamed");
    expect(JSON.stringify(after.networking)).toContain("web.renamed.internal");
    const added = await plan("renamed", { later: { type: "postgres" } });
    expect(added.services[ServiceName.make("later")]?.connection?.creds.database).toBe("original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt user records fail closed while scratch and global planning ignore them", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-data-isolation-"));
  const store = makeTestStateStore();
  const layer = AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.merge(PluginRegistryLayer.layer, store.layer)),
  );
  try {
    const identity = await Effect.runPromise(resolveAppIdentity(root));
    const bucket = await Effect.runPromise(store.service.open(appDataIdentityBucketSpec(identity)));
    await Effect.runPromise(store.writeRaw(bucket.path, "broken"));
    const landofile = literalTestLandofile(
      Schema.decodeUnknownSync(LandofileShape)({ name: "current" }),
      root,
    );
    const plan = (kind: "user" | "scratch" | "global") =>
      Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) =>
          planner.plan(landofile, TestRuntimeProvider.capabilities, { kind }),
        ).pipe(Effect.provide(layer)),
      );

    await expect(plan("user")).rejects.toMatchObject({ _tag: "AppDataIdentityError" });
    expect((await plan("scratch")).identity?.dataName).toBe("current");
    expect((await plan("global")).identity?.dataName).toBe("current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
