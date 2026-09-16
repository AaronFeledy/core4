import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Layer, Schema } from "effect";

import { FileSystemLive } from "@lando/engine/services/file-system";
import { makeLandoPaths } from "@lando/paths";
import { StateStoreError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, PathsService, StateStore } from "@lando/sdk/services";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";

import { readAppliedPlansFromUserData } from "../../src/cli/commands/list-discovery.ts";
import { listServicesWithPrune } from "../../src/cli/commands/list.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = async (provider: string) => {
  const root = await mkdtemp(join(tmpdir(), "lando-legacy-prune-"));
  roots.push(root);
  const paths = makeLandoPaths({ userDataRoot: root, userCacheRoot: root, userConfRoot: root });
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const legacyDir = join(root, "providers", `provider-${provider}`, "apps");
  await mkdir(legacyDir, { recursive: true });
  const plan = { id: "alpha", name: "alpha", root: join(root, "missing"), provider, services: {} };
  const legacy = { version: 1, providerId: provider, plan };
  const legacyPath = join(legacyDir, "unrelated-filename.json");
  await writeFile(legacyPath, JSON.stringify(legacy));
  const store = makeStateStore({
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
  });
  const run = (failRemoval = false) =>
    Effect.runPromise(
      listServicesWithPrune({
        userDataRoot: root,
        userCacheRoot: root,
        discoverContainersEvidence: async () => ({
          apps: [],
          confirmedProviderIds: [provider],
          ownedAppIds: [],
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ConfigService, {
              load: Effect.succeed(config),
              get: (key) => Effect.succeed(config[key]),
            }),
            Layer.succeed(PathsService, paths),
            Layer.succeed(StateStore, {
              ...store,
              open: (spec) =>
                store.open(spec).pipe(
                  Effect.map((bucket) => {
                    if (!failRemoval || bucket.path !== legacyPath) return bucket;
                    expect(spec.lock).toBe("advisory");
                    return {
                      ...bucket,
                      remove: Effect.fail(
                        new StateStoreError({
                          reason: "io",
                          operation: "remove",
                          path: legacyPath,
                        }),
                      ),
                    };
                  }),
                ),
            }),
            FileSystemLive,
            PrivateFileAccessLive,
          ),
        ),
        Effect.either,
      ),
    ).then((result) => {
      if (Either.isLeft(result)) throw result.left;
      return result.right;
    });
  return { root, paths, legacyDir, legacyPath, legacy, plan, run };
};

test.each(["lando", "docker"])(
  "removes legacy-only arbitrary filenames when %s confirms empty",
  async (provider) => {
    // Given: only legacy state, with no plan.provider or envelope providerId.
    const f = await fixture(provider);
    const { provider: _provider, ...plan } = f.plan;
    await writeFile(f.legacyPath, JSON.stringify({ version: 1, plan }));
    // When: prune uses provider-confirmed empty evidence.
    const result = await f.run();
    // Then: the receipt names the app, and a fresh inventory cannot resurrect it.
    expect(result.pruned?.map((entry) => entry.appId)).toEqual(["alpha"]);
    expect(result.apps).toEqual([]);
    expect(await readAppliedPlansFromUserData(f.root)).toEqual([]);
    expect(await Bun.file(f.legacyPath).exists()).toBe(false);
  },
);

test.each(["lando", "docker"])(
  "removes modern and legacy duplicates but preserves another %s app",
  async (provider) => {
    // Given: modern state plus two arbitrarily named legacy copies and an unrelated live root.
    const f = await fixture(provider);
    const modern = join(f.paths.pluginStateDir(`@lando/provider-${provider}`), "applied-plans", "alpha.json");
    await mkdir(join(modern, ".."), { recursive: true });
    await writeFile(modern, JSON.stringify({ version: 1, data: f.plan }));
    await writeFile(join(f.legacyDir, "second-copy.json"), JSON.stringify(f.legacy));
    const otherPath = join(f.legacyDir, "alpha.json");
    const other = JSON.stringify({ ...f.legacy, plan: { ...f.plan, id: "other", root: f.root } });
    await writeFile(otherPath, other);
    // When
    const result = await f.run();
    // Then
    expect(result.pruned?.map((entry) => entry.appId)).toEqual(["alpha"]);
    expect((await readAppliedPlansFromUserData(f.root)).map((entry) => entry.appId)).toEqual(["other"]);
    expect(await readFile(otherPath, "utf8")).toBe(other);
  },
);

test.each(["lando", "docker"])(
  "fails without a successful receipt when %s legacy removal fails",
  async (provider) => {
    // Given: an IO failure at the durable removal seam.
    const f = await fixture(provider);
    // When / Then: no successful result, and recovery evidence remains.
    const failure = await f.run(true).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ _tag: "StateStoreError", operation: "remove" });
    expect(await Bun.file(f.legacyPath).exists()).toBe(true);
  },
);

test.each(["root", "providerId", "provider"])(
  "preserves legacy state when %s conflicts with the selected app",
  async (field) => {
    // Given: a modern authoritative entry and a conflicting legacy record.
    const f = await fixture("lando");
    const modern = join(f.paths.pluginStateDir("@lando/provider-lando"), "applied-plans", "alpha.json");
    await mkdir(join(modern, ".."), { recursive: true });
    await writeFile(modern, JSON.stringify({ version: 1, data: f.plan }));
    const conflicting = JSON.stringify(
      field === "providerId"
        ? { ...f.legacy, providerId: "docker" }
        : { ...f.legacy, plan: { ...f.plan, [field]: field === "root" ? f.root : "docker" } },
    );
    await writeFile(f.legacyPath, conflicting);
    // When
    const failure = await f.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ _tag: "StateStoreError", operation: "prune" });
    // Then: filename or merged discovery cannot authorize deleting conflicting state.
    expect(await readFile(f.legacyPath, "utf8")).toBe(conflicting);
  },
);

test("keeps adjacent podman record pruning scoped to one app", async () => {
  // Given: Podman's shared record contains two valid app plans.
  const f = await fixture("podman");
  const record = join(f.paths.pluginStateDir("@lando/provider-podman"), "applied-plans.json");
  await mkdir(join(record, ".."), { recursive: true });
  const plan = {
    ...f.plan,
    slug: "alpha",
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: "2026-09-15T00:00:00.000Z", source: "applied-state", runtime: 4 },
  };
  const other = { ...plan, id: "other", slug: "other", root: f.root };
  await writeFile(record, JSON.stringify({ version: 1, data: { alpha: plan, other } }));
  // When
  const result = await f.run();
  // Then
  expect(result.pruned?.map((entry) => entry.appId)).toEqual(["alpha"]);
  expect((await readAppliedPlansFromUserData(f.root)).map((entry) => entry.appId)).toEqual(["other"]);
});
