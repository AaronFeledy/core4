import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, planAppIdentity } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { Effect } from "effect";
import { withSqliteHelper } from "../src/sqlite-helper.ts";
import { persistSqliteSnapshot } from "../src/sqlite-snapshot.ts";
import { openSqliteSidecar } from "./support/sqlite-sidecar.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("returns a catalogued manual snapshot ID when scratch cleanup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-cleanup-"));
  roots.push(root);
  const paths = makeLandoPaths({ userDataRoot: root, env: {} });
  const owner = planAppIdentity({ root: AbsolutePath.make(root) });
  const stateStore = await Effect.runPromise(StateStore.pipe(Effect.provide(DiskStateStore.layer)));
  const deps = {
    applied: { root: owner.appRoot, identity: owner },
    paths,
    stateStore,
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
    inspect: () =>
      Effect.succeed({
        status: "running" as const,
        running: true,
        containerId: "container",
        imageIdentity: "image",
      }),
    pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
    run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }),
  };
  const target = {
    kind: "file",
    family: "sqlite",
    name: "appserver",
    type: "php",
    path: "db.sqlite",
  } as const;
  const handle = await Effect.runPromise(
    withSqliteHelper(
      deps,
      {
        name: target.name,
        type: target.type,
        environment: {},
        extensions: {},
        storage: [],
        mounts: [{ type: "bind", role: "app", source: root, target: "/app", readOnly: false }],
      },
      target,
      (helper) =>
        Effect.gen(function* () {
          const payload = join(helper.scratchHost, "db.sqlite");
          yield* Effect.promise(() => writeFile(payload, "SQLite format 3\0manual snapshot"));
          const handle = yield* persistSqliteSnapshot(
            deps,
            { id: "app", name: "app", root, services: {} },
            target,
            payload,
            "3.45.0",
            { id: "manual" },
          );
          Object.assign(helper, { scratchRoot: "invalid\0path" });
          return handle;
        }),
    ),
  );
  expect(handle.id).toBe("manual");
  const info = await Effect.runPromise(
    Effect.gen(function* () {
      const bucket = yield* openSqliteSidecar(
        stateStore,
        join(paths.ownerSnapshotsDir(owner.ownerKey), handle.store.store),
        "manual",
      );
      return yield* bucket.get;
    }),
  );
  expect(info?.id).toBe("manual");
});
