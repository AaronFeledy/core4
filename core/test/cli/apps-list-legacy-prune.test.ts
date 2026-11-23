import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLIED_STATE_VERSION } from "@lando/container-runtime/applied-state";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeLandoPaths } from "@lando/paths";
import { StateStoreError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, PathsService, StateStore } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer, Result, Schema } from "effect";
import { AppsListResultSchema, listServicesWithPrune } from "../../src/cli/commands/list.ts";
import { readAppliedPlansFromUserData } from "../../src/cli/commands/list-discovery.ts";
import { pruneAppliedPlanState } from "../../src/cli/commands/list-prune-state.ts";

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
  const run = (failRemoval = false, idle: boolean | "unknown" = false) =>
    Effect.runPromise(
      listServicesWithPrune({
        userDataRoot: root,
        userCacheRoot: root,
        discoverContainersEvidence: async () => ({
          apps: [],
          confirmedProviderIds: idle ? [] : [provider],
          idleProviderIds: idle === true ? [provider] : [],
          ownedResources: [],
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              ConfigService,
              ConfigService.of({
                load: Effect.succeed(config),
                get: (key) => Effect.succeed(config[key]),
              }),
            ),
            Layer.succeed(PathsService, paths),
            Layer.succeed(
              StateStore,
              StateStore.of({
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
                            remediation: "Injected legacy path remove failure for prune fixture.",
                          }),
                        ),
                      };
                    }),
                  ),
              }),
            ),
            BunFileSystem.layer,
            PrivateFileAccessService.layer,
          ),
        ),
        Effect.result,
      ),
    ).then((result) => {
      if (Result.isFailure(result)) throw result.failure;
      return result.success;
    });
  return { root, paths, legacyDir, legacyPath, legacy, plan, store, run };
};

test.each([
  { name: "idle", idle: true, status: "stopped" },
  { name: "unknown", idle: "unknown", status: "unknown" },
] as const)("$name never authorizes pruning retained inventory", async ({ idle, status }) => {
  const f = await fixture("lando");
  const result = await f.run(false, idle);
  expect(result.apps).toMatchObject([{ appId: "alpha", status, stale: true }]);
  expect(result.pruned).toEqual([]);
  expect(await Bun.file(f.legacyPath).json()).toEqual(f.legacy);
});

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

test.each(["providerId", "provider"])(
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
        : { ...f.legacy, plan: { ...f.plan, provider: "docker" } },
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

test("prunes the selected root and keeps a legacy record at another root", async () => {
  // Given: a modern authoritative entry and a same-id legacy record at another root.
  const f = await fixture("lando");
  const modern = join(f.paths.pluginStateDir("@lando/provider-lando"), "applied-plans", "alpha.json");
  await mkdir(join(modern, ".."), { recursive: true });
  await writeFile(modern, JSON.stringify({ version: 1, data: f.plan }));
  const otherRoot = JSON.stringify({ ...f.legacy, plan: { ...f.plan, root: f.root } });
  await writeFile(f.legacyPath, otherRoot);

  // When: prune runs for the selected app root.
  const result = await f.run();

  // Then: only the selected root leaves the inventory; the other checkout stays.
  expect(result.pruned?.map((entry) => entry.appId)).toEqual(["alpha"]);
  expect(await Bun.file(modern).exists()).toBe(false);
  expect(await readFile(f.legacyPath, "utf8")).toBe(otherRoot);
});

test("keeps adjacent podman record pruning scoped to one app", async () => {
  // Given: Podman's shared record contains two valid app plans.
  const f = await fixture("podman");
  const record = join(f.paths.pluginStateDir("@lando/provider-podman"), "applied-plans.json");
  await mkdir(join(record, ".."), { recursive: true });
  const plan = {
    ...f.plan,
    slug: "alpha",
    routes: [],
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

test.each(["lando", "docker"])(
  "does not delete a live modern %s record for a stale missing-root candidate",
  async (provider) => {
    // Given: a missing-root prune candidate and a same-id modern record at a live root.
    const f = await fixture(provider);
    const liveRoot = await mkdtemp(join(tmpdir(), "lando-live-prune-"));
    roots.push(liveRoot);
    const modern = join(f.paths.pluginStateDir(`@lando/provider-${provider}`), "applied-plans", "alpha.json");
    await mkdir(join(modern, ".."), { recursive: true });
    const payload = JSON.stringify({ version: 1, data: { ...f.plan, root: liveRoot } });
    await writeFile(modern, payload);
    // When: prune is asked to remove the missing-root identity, not the live root.
    const outcome = await Effect.runPromise(
      pruneAppliedPlanState(f.paths, f.store, {
        appId: "alpha",
        appName: "alpha",
        providerId: provider,
        appRoot: f.plan.root,
        services: [],
      }).pipe(Effect.provide(BunFileSystem.layer)),
    );
    // Then: the live modern record is unchanged; legacy-only evidence was removed.
    expect(await readFile(modern, "utf8")).toBe(payload);
    expect(outcome).toEqual({ status: "removed" });
  },
);

test("does not delete a live podman record for a stale missing-root candidate", async () => {
  // Given: Podman's shared record now belongs to a live root for the same app id.
  const f = await fixture("podman");
  const liveRoot = await mkdtemp(join(tmpdir(), "lando-live-prune-"));
  roots.push(liveRoot);
  const record = join(f.paths.pluginStateDir("@lando/provider-podman"), "applied-plans.json");
  await mkdir(join(record, ".."), { recursive: true });
  const plan = {
    ...f.plan,
    root: liveRoot,
    slug: "alpha",
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: "2026-09-15T00:00:00.000Z", source: "applied-state", runtime: 4 },
  };
  const payload = JSON.stringify({ version: 1, data: { alpha: plan } });
  await writeFile(record, payload);
  // When
  const outcome = await Effect.runPromise(
    pruneAppliedPlanState(f.paths, f.store, {
      appId: "alpha",
      appName: "alpha",
      providerId: "podman",
      appRoot: f.plan.root,
      services: [],
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
  // Then
  expect(outcome).toEqual({ status: "kept" });
  expect(await readFile(record, "utf8")).toBe(payload);
});

test.each(["lando", "podman"])(
  "prunes a missing-root %s app recorded at the current applied-state version",
  async (provider) => {
    // Given: applied state written in the provider's current on-disk version, not the legacy one.
    const f = await fixture(provider);
    const stateDir = f.paths.pluginStateDir(`@lando/provider-${provider}`);
    const plan = {
      ...f.plan,
      slug: "alpha",
      routes: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata: { resolvedAt: "2026-09-15T00:00:00.000Z", source: "applied-state", runtime: 4 },
    };
    const other = { ...plan, id: "other", slug: "other", root: f.root };
    if (provider === "podman") {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "applied-plans.json"),
        JSON.stringify({ version: APPLIED_STATE_VERSION, data: { alpha: plan, other } }),
      );
    } else {
      await mkdir(join(stateDir, "applied-plans"), { recursive: true });
      await writeFile(
        join(stateDir, "applied-plans", "alpha.json"),
        JSON.stringify({ version: APPLIED_STATE_VERSION, data: plan }),
      );
      await writeFile(
        join(stateDir, "applied-plans", "other.json"),
        JSON.stringify({ version: APPLIED_STATE_VERSION, data: other }),
      );
    }
    await rm(f.legacyPath);
    // When
    const result = await f.run();
    // Then: the stale app is removed and the live one stays.
    expect(result.pruned?.map((entry) => entry.appId)).toEqual(["alpha"]);
    expect((await readAppliedPlansFromUserData(f.root)).map((entry) => entry.appId)).toEqual(["other"]);
  },
);

const podmanRecordPath = (paths: ReturnType<typeof makeLandoPaths>) =>
  join(paths.pluginStateDir("@lando/provider-podman"), "applied-plans.json");

const writePodmanRecord = async (path: string, version: number, data: unknown) => {
  await mkdir(join(path, ".."), { recursive: true });
  const body = `${JSON.stringify({ version, data }, null, 2)}\n`;
  await writeFile(path, body);
  return body;
};

const prunePodman = (f: Awaited<ReturnType<typeof fixture>>, appRoot: string) =>
  Effect.runPromise(
    pruneAppliedPlanState(f.paths, f.store, {
      appId: "alpha",
      appName: "alpha",
      providerId: "podman",
      appRoot,
      services: [],
    }).pipe(Effect.provide(BunFileSystem.layer), Effect.result),
  );

const metadata = { resolvedAt: "2026-09-15T00:00:00.000Z", source: "applied-state", runtime: 4 };
const podmanPlan = (id: string, root: string, services: Record<string, unknown> = {}) => ({
  id,
  name: id,
  slug: id,
  root,
  provider: "podman",
  services,
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata,
});
const webWithEndpoint = (endpoint: Record<string, unknown>) => ({
  web: {
    name: "web",
    type: "lando",
    provider: "podman",
    primary: true,
    artifact: { kind: "ref", ref: "busybox:1.37" },
    environment: {},
    mounts: [],
    endpoints: [endpoint],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  },
});

test("podman prune protects a future-version map without deleting it", async () => {
  // Given: a shared Podman record stamped by a newer Lando.
  const f = await fixture("podman");
  const record = podmanRecordPath(f.paths);
  const data = { alpha: podmanPlan("alpha", "/missing") };
  const payload = await writePodmanRecord(record, APPLIED_STATE_VERSION + 1, data);
  await rm(f.legacyPath);

  // When
  const result = await prunePodman(f, "/missing");

  // Then: protected skip, bytes intact, upgrade remediation.
  if (Result.isFailure(result)) throw result.failure;
  expect(result.success.status).toBe("protected");
  if (result.success.status !== "protected") throw new Error("expected protected");
  expect(result.success.failure).toMatchObject({
    reason: "newer-version",
    storedVersion: APPLIED_STATE_VERSION + 1,
    supportedVersion: APPLIED_STATE_VERSION,
    providerId: "podman",
  });
  expect(result.success.failure.remediation).not.toMatch(/move it aside|destroy/i);
  expect(await readFile(record, "utf8")).toBe(payload);
});

test.each([
  {
    name: "legacy map with mixed endpoint discriminators",
    version: 7,
    data: {
      alpha: podmanPlan(
        "alpha",
        "/missing",
        webWithEndpoint({ _tag: "internal", kind: "internal", protocol: "http", port: 80 }),
      ),
    },
  },
  {
    name: "current map still carrying old endpoint keys",
    version: APPLIED_STATE_VERSION,
    data: {
      alpha: podmanPlan(
        "alpha",
        "/missing",
        webWithEndpoint({ _tag: "internal", protocol: "http", port: 80 }),
      ),
    },
  },
])("podman prune leaves an unreadable $name map byte-identical", async ({ version, data }) => {
  // Given: a shared Podman record the strict opener cannot trust.
  const f = await fixture("podman");
  const record = podmanRecordPath(f.paths);
  const payload = await writePodmanRecord(record, version, data);
  await rm(f.legacyPath);

  // When
  const result = await prunePodman(f, "/missing");

  // Then: mutation fails and the durable bytes are untouched.
  if (Result.isSuccess(result)) throw new Error("expected prune failure");
  expect(result.failure).toMatchObject({ _tag: "StateStoreError" });
  expect(await readFile(record, "utf8")).toBe(payload);
});

test.each([
  { name: "the selected root does not match", app: "alpha" },
  { name: "the app has no entry", app: "other" },
])("podman prune keeps a valid map without rewriting it when $name", async ({ app }) => {
  // Given: a readable current-version map with no alpha entry at the selected root.
  const f = await fixture("podman");
  const record = podmanRecordPath(f.paths);
  const payload = await writePodmanRecord(record, APPLIED_STATE_VERSION, {
    [app]: podmanPlan(app, f.root),
  });
  await rm(f.legacyPath);

  // When
  const result = await prunePodman(f, f.plan.root);

  // Then: Keep, no write; a lost match is not treated as empty inventory.
  if (Result.isFailure(result)) throw result.failure;
  expect(result.success).toEqual({ status: "kept" });
  expect(await readFile(record, "utf8")).toBe(payload);
});

test.each(["lando", "docker"])(
  "warns without inventing a prune candidate from a future-version %s body",
  async (provider) => {
    // Given: modern state from a newer Lando is the only record for the missing root.
    const f = await fixture(provider);
    await rm(f.legacyPath);
    const modern = join(f.paths.pluginStateDir(`@lando/provider-${provider}`), "applied-plans", "alpha.json");
    await mkdir(join(modern, ".."), { recursive: true });
    const writtenBy = "4.15.0";
    const payload = JSON.stringify({ version: APPLIED_STATE_VERSION + 1, writtenBy, data: f.plan });
    await writeFile(modern, payload);

    // When
    const result = await f.run();

    // Then: no row or prune candidate, but the version issue survives.
    expect(result.apps).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(result.pruneFailures).toBeUndefined();
    const wire = Schema.encodeSync(AppsListResultSchema)(result);
    expect(wire.appliedStateIssues).toEqual([
      expect.objectContaining({
        reason: "newer-version",
        providerId: provider,
        path: modern,
        writtenBy,
        storedVersion: APPLIED_STATE_VERSION + 1,
        supportedVersion: APPLIED_STATE_VERSION,
      }),
    ]);
    const failure = result.appliedStateIssues?.[0];
    expect(failure?.remediation).not.toMatch(/move it aside|destroy/i);
    expect(await readFile(modern, "utf8")).toBe(payload);
  },
);

test.each(
  (["lando", "docker"] as const).flatMap((provider) =>
    (["same", "other"] as const).map((claimedRoot) => ({ provider, claimedRoot })),
  ),
)(
  "keeps a legacy row and a future-version modern record whose $claimedRoot root it cannot prove ($provider)",
  async ({ provider, claimedRoot }) => {
    // Given: a stale legacy row at a missing root and a same-id record from a newer Lando.
    const f = await fixture(provider);
    const modern = join(f.paths.pluginStateDir(`@lando/provider-${provider}`), "applied-plans", "alpha.json");
    await mkdir(join(modern, ".."), { recursive: true });
    const root = claimedRoot === "same" ? f.plan.root : join(f.root, "elsewhere");
    const payload = JSON.stringify({ version: APPLIED_STATE_VERSION + 1, data: { ...f.plan, root } });
    await writeFile(modern, payload);
    const legacyBody = await readFile(f.legacyPath, "utf8");

    // When
    const outcome = await Effect.runPromise(
      pruneAppliedPlanState(f.paths, f.store, {
        appId: "alpha",
        appName: "alpha",
        providerId: provider,
        appRoot: f.plan.root,
        services: [],
      }).pipe(Effect.provide(BunFileSystem.layer)),
    );

    // Then: the newer payload's root is not trusted either way; nothing is deleted or reported.
    expect(outcome).toEqual({ status: "kept" });
    expect(await readFile(modern, "utf8")).toBe(payload);
    expect(await readFile(f.legacyPath, "utf8")).toBe(legacyBody);
  },
);

test.each(["lando", "docker"])(
  "keeps a readable modern %s record whose stored id differs from its key",
  async (provider) => {
    // Given: the candidate's key holds a readable record for another app at the same missing root.
    const f = await fixture(provider);
    await rm(f.legacyPath);
    const modern = join(f.paths.pluginStateDir(`@lando/provider-${provider}`), "applied-plans", "alpha.json");
    await mkdir(join(modern, ".."), { recursive: true });
    const payload = JSON.stringify({ version: APPLIED_STATE_VERSION, data: { ...f.plan, id: "beta" } });
    await writeFile(modern, payload);

    // When
    const outcome = await Effect.runPromise(
      pruneAppliedPlanState(f.paths, f.store, {
        appId: "alpha",
        appName: "alpha",
        providerId: provider,
        appRoot: f.plan.root,
        services: [],
      }).pipe(Effect.provide(BunFileSystem.layer)),
    );

    // Then
    expect(outcome).toEqual({ status: "kept" });
    expect(await readFile(modern, "utf8")).toBe(payload);
  },
);

test("prunes an unrelated candidate while protecting a future-version podman record", async () => {
  // Given: one protected newer podman map entry and one removable lando legacy-only app.
  const f = await fixture("podman");
  const record = podmanRecordPath(f.paths);
  const payload = await writePodmanRecord(record, APPLIED_STATE_VERSION + 1, {
    alpha: podmanPlan("alpha", f.plan.root),
  });
  await rm(f.legacyPath);

  const landoLegacyDir = join(f.root, "providers", "provider-lando", "apps");
  await mkdir(landoLegacyDir, { recursive: true });
  const betaRoot = join(f.root, "missing-beta");
  const betaLegacy = {
    version: 1 as const,
    providerId: "lando",
    plan: { id: "beta", name: "beta", root: betaRoot, provider: "lando", services: {} },
  };
  await writeFile(join(landoLegacyDir, "beta.json"), JSON.stringify(betaLegacy));

  const result = await Effect.runPromise(
    listServicesWithPrune({
      userDataRoot: f.root,
      userCacheRoot: f.root,
      discoverContainersEvidence: async () => ({
        apps: [],
        confirmedProviderIds: ["podman", "lando"],
        ownedResources: [],
      }),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            ConfigService,
            ConfigService.of({
              load: Effect.succeed(Schema.decodeUnknownSync(GlobalConfig)({})),
              get: (key) => Effect.succeed(Schema.decodeUnknownSync(GlobalConfig)({})[key]),
            }),
          ),
          Layer.succeed(PathsService, f.paths),
          Layer.succeed(StateStore, StateStore.of(f.store)),
          BunFileSystem.layer,
          PrivateFileAccessService.layer,
        ),
      ),
    ),
  );

  // Then: beta pruned, alpha protected, podman bytes intact.
  expect(result.pruned?.map((entry) => entry.appId)).toEqual(["beta"]);
  expect(result.pruneFailures).toBeUndefined();
  expect(result.appliedStateIssues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: "newer-version",
        providerId: "podman",
        storedVersion: APPLIED_STATE_VERSION + 1,
      }),
    ]),
  );
  expect(await readFile(record, "utf8")).toBe(payload);
  expect(await Bun.file(join(landoLegacyDir, "beta.json")).exists()).toBe(false);
});

test("prune leaves a newer record at an existing app root alone without reporting failure", async () => {
  const f = await fixture("lando");
  await rm(f.legacyPath);
  const existingRoot = await mkdtemp(join(tmpdir(), "lando-existing-newer-"));
  roots.push(existingRoot);
  const modern = join(f.paths.pluginStateDir("@lando/provider-lando"), "applied-plans", "alpha.json");
  await mkdir(join(modern, ".."), { recursive: true });
  const payload = JSON.stringify({
    version: APPLIED_STATE_VERSION + 1,
    data: { ...f.plan, root: existingRoot },
  });
  await writeFile(modern, payload);

  const result = await f.run();

  expect(result.pruned).toEqual([]);
  expect(result).not.toHaveProperty("pruneFailures");
  expect(await readFile(modern, "utf8")).toBe(payload);
});
