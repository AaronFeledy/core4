import { describe, expect, it } from "bun:test";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import { type StateBucketSpec, StateStore } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import {
  cacheVerifiedSource,
  loadActionMetadata,
  loadCachedSource,
  parseActionReference,
  resolveFixtureReference,
  sourceCacheIdentity,
  verifyFixtureSource,
} from "../src/actions/source/index.ts";

const location = { file: ".github/workflows/check.yml", line: 4, column: 11 };
const commit = "a".repeat(40);
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = async <A, E>(effect: Effect.Effect<A, E>) => {
  const result = await run(Effect.result(effect));
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("Expected failure");
  return result.failure;
};
// This controlled SDK service fixture verifies orchestration, not physical persistence or permissions.
const storeFixture = () => {
  const records = new Map<string, unknown>();
  const specs: StateBucketSpec<unknown, unknown>[] = [];
  const service = StateStore.of({
    open: <A, I>(spec: StateBucketSpec<A, I>) =>
      Effect.sync(() => {
        specs.push(spec as StateBucketSpec<unknown, unknown>);
        const path = `/controlled/${spec.namespace}/${spec.key}` as AbsolutePath;
        const read = () =>
          records.has(path) ? Schema.decodeUnknownSync(spec.schema)(records.get(path)) : null;
        return {
          path,
          get: Effect.try({
            try: read,
            catch: () =>
              new StateStoreError({
                reason: "decode",
                operation: "fixture-get",
                remediation: "Replace the controlled fixture record.",
              }),
          }),
          set: (value: A) =>
            Effect.sync(() => {
              records.set(path, JSON.parse(JSON.stringify(value)));
            }),
          update: (f: (value: A | null) => A) =>
            Effect.sync(() => {
              const next = f(read());
              records.set(path, next);
              return next;
            }),
          modify: <B>(f: (value: A | null) => readonly [B, A]) =>
            Effect.sync(() => {
              const [result, next] = f(read());
              records.set(path, next);
              return result;
            }),
          exists: Effect.sync(() => records.has(path)),
          remove: Effect.sync(() => {
            records.delete(path);
          }),
        };
      }),
    withLock: (_key, body) => body,
  });
  return { records, specs, service };
};
const fixture = async (ref = "v1", resolvedCommit = commit, repository = "owner/repo", subpath = "") => {
  const reference = await run(
    parseActionReference(`${repository}${subpath ? `/${subpath}` : ""}@${ref}`, location),
  );
  if (reference.kind !== "repository") throw new Error("Expected repository");
  const resolved = await run(
    resolveFixtureReference(reference, {
      origin: reference.origin,
      repository: reference.repository,
      requestedRef: ref,
      commit: resolvedCommit,
      provenance: "trusted-fixture",
    }),
  );
  const bytes = new TextEncoder().encode(
    "name: fixture\ndescription: fixture\nruns:\n  using: node24\n  main: main.js\n",
  );
  const license = new TextEncoder().encode("MIT fixture license\n");
  const files = [
    { path: `${subpath ? `${subpath}/` : ""}action.yml`, bytes },
    { path: "LICENSE", bytes: license },
  ];
  const manifest = {
    origin: resolved.origin,
    repository: resolved.repository,
    commit: resolved.commit,
    subpath,
    metadataPath: `${subpath ? `${subpath}/` : ""}action.yml`,
    files: files.map((file) => ({ path: file.path, size: file.bytes.length, sha256: sha256Hex(file.bytes) })),
    licenses: ["LICENSE"],
  };
  const verified = await run(verifyFixtureSource(resolved, manifest, files));
  return { resolved, manifest, verified };
};

describe("controlled verified fixture cache orchestration", () => {
  it("stores with owner namespace, version, 0600 and advisory locking, then verifies an offline hit", async () => {
    const store = storeFixture();
    const { resolved, manifest, verified } = await fixture();
    const provide = <A, E>(effect: Effect.Effect<A, E, StateStore>) =>
      Effect.provideService(effect, StateStore, store.service);
    await run(provide(cacheVerifiedSource(verified)));
    expect(store.specs[0]).toMatchObject({
      root: "userCache",
      namespace: "github-actions-source",
      version: 1,
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "fail",
    });
    const loaded = await run(provide(loadCachedSource(resolved, manifest)));
    expect(loaded.receipt).toEqual(verified.receipt);
    expect(await run(loadActionMetadata(loaded))).toMatchObject({ kind: "node24" });
  });
  it("reports an offline miss without network or a mutable reference mapping", async () => {
    const store = storeFixture();
    const { resolved, manifest } = await fixture();
    expect(
      await failure(Effect.provideService(loadCachedSource(resolved, manifest), StateStore, store.service)),
    ).toMatchObject({ reason: "offline-miss", source: location });
  });
  it("does not alias tag movement, subpaths, repositories or origins", async () => {
    const first = await fixture();
    const moved = await fixture("v1", "b".repeat(40));
    const canonical = await fixture("v1", commit, "Owner/Repo");
    expect(sourceCacheIdentity(first.resolved)).toBe(sourceCacheIdentity(canonical.resolved));
    const identities = [
      first.resolved,
      moved.resolved,
      { ...first.resolved, repository: "owner/repo-2" },
      { ...first.resolved, origin: "https://github.example" },
    ].map(sourceCacheIdentity);
    expect(new Set(identities).size).toBe(identities.length);
    expect(sourceCacheIdentity({ ...first.resolved, subpath: "tool" })).toBe(
      sourceCacheIdentity(first.resolved),
    );
    const store = storeFixture();
    await run(Effect.provideService(cacheVerifiedSource(first.verified), StateStore, store.service));
    expect(
      await failure(
        Effect.provideService(loadCachedSource(moved.resolved, moved.manifest), StateStore, store.service),
      ),
    ).toMatchObject({ reason: "offline-miss" });
  });
  it("rechecks each hit and detects payload tampering", async () => {
    const store = storeFixture();
    const { resolved, manifest, verified } = await fixture();
    await run(Effect.provideService(cacheVerifiedSource(verified), StateStore, store.service));
    const entry = [...store.records.entries()][0];
    if (entry === undefined) throw new Error("Expected stored source");
    const poisoned = JSON.parse(JSON.stringify(entry[1]));
    const selection = poisoned.selections[sha256Hex(resolved.subpath)];
    selection.files[0].base64 = Buffer.from("POISONED_METADATA").toString("base64");
    store.records.set(entry[0], poisoned);
    expect(
      await failure(Effect.provideService(loadCachedSource(resolved, manifest), StateStore, store.service)),
    ).toMatchObject({ reason: "integrity-mismatch" });
  });
  it("rejects manifest and payload rewritten together even when their own digest matches", async () => {
    const store = storeFixture();
    const { resolved, manifest, verified } = await fixture();
    await run(Effect.provideService(cacheVerifiedSource(verified), StateStore, store.service));
    const entry = [...store.records.entries()][0];
    if (entry === undefined) throw new Error("Expected stored source");
    const poisoned = JSON.parse(JSON.stringify(entry[1]));
    const selection = poisoned.selections[sha256Hex(resolved.subpath)];
    const bytes = Buffer.from("ATTACKER_METADATA");
    selection.files[0].base64 = bytes.toString("base64");
    selection.manifest.files[0].sha256 = sha256Hex(bytes);
    selection.manifest.files[0].size = bytes.length;
    selection.integrity = sha256Hex(canonicalJson(selection.manifest));
    store.records.set(entry[0], poisoned);
    expect(
      await failure(Effect.provideService(loadCachedSource(resolved, manifest), StateStore, store.service)),
    ).toMatchObject({ reason: "integrity-mismatch" });
  });
  it("binds cache hits to independent expected size, subpath and origin", async () => {
    const store = storeFixture();
    const { resolved, manifest, verified } = await fixture();
    await run(Effect.provideService(cacheVerifiedSource(verified), StateStore, store.service));
    for (const changed of [
      { ...manifest, origin: "https://evil.example" },
      { ...manifest, subpath: "tool" },
      {
        ...manifest,
        files: manifest.files.map((file, index) => (index === 0 ? { ...file, size: file.size + 1 } : file)),
      },
    ]) {
      expect(
        await failure(Effect.provideService(loadCachedSource(resolved, changed), StateStore, store.service)),
      ).toMatchObject({ reason: "integrity-mismatch" });
    }
  });
  it("keeps separate metadata selections in one canonical repository commit bucket", async () => {
    const first = await fixture();
    const selected = await fixture("v1", commit, "owner/repo", "tool");
    const store = storeFixture();
    for (const source of [first.verified, selected.verified])
      await run(Effect.provideService(cacheVerifiedSource(source), StateStore, store.service));
    expect(store.records.size).toBe(1);
    for (const source of [first, selected]) {
      const loaded = await run(
        Effect.provideService(loadCachedSource(source.resolved, source.manifest), StateStore, store.service),
      );
      expect(loaded.receipt.subpath).toBe(source.resolved.subpath);
      expect(await run(loadActionMetadata(loaded))).toMatchObject({ kind: "node24" });
    }
  });
  it("rejects retained repository bytes above the aggregate budget before replacement", async () => {
    const { verified } = await fixture();
    const store = storeFixture();
    await run(Effect.provideService(cacheVerifiedSource(verified), StateStore, store.service));
    const entry = [...store.records.entries()][0];
    if (entry === undefined) throw new Error("Expected stored source");
    const record = JSON.parse(JSON.stringify(entry[1]));
    const selection = record.selections[sha256Hex("")];
    // Each encoding fits the per-file schema, while their combined retained bytes exceed 8 MiB.
    selection.files = Array.from({ length: 40 }, () => ({
      path: "action.yml",
      base64: "A".repeat(Math.ceil((256 * 1024) / 3) * 4),
    }));
    const oversized = { selections: { ["b".repeat(64)]: selection } };
    store.records.set(entry[0], oversized);
    expect(
      await failure(Effect.provideService(cacheVerifiedSource(verified), StateStore, store.service)),
    ).toMatchObject({ reason: "source-limit" });
    expect(store.records.get(entry[0])).toEqual(oversized);
  });
  it("rejects cache encodings exceeding the schema bound without retaining decoder details", async () => {
    const { resolved, manifest, verified } = await fixture();
    const store = storeFixture();
    await run(Effect.provideService(cacheVerifiedSource(verified), StateStore, store.service));
    const entry = [...store.records.entries()][0];
    if (entry === undefined) throw new Error("Expected stored source");
    const record = JSON.parse(JSON.stringify(entry[1]));
    record.selections[sha256Hex("")].files[0].base64 = "A".repeat(Math.ceil((256 * 1024) / 3) * 4 + 1);
    store.records.set(entry[0], record);
    expect(
      await failure(Effect.provideService(loadCachedSource(resolved, manifest), StateStore, store.service)),
    ).toMatchObject({ reason: "cache-failed" });
  });
  it("drops SDK StateStore errors with private paths or causes", async () => {
    const { verified } = await fixture();
    const privateValue = "PRIVATE_STORE_DETAIL";
    const service = StateStore.of({
      open: () =>
        Effect.fail(
          new StateStoreError({
            reason: "io",
            operation: privateValue,
            path: privateValue,
            cause: new Error(privateValue),
            remediation: privateValue,
          }),
        ),
      withLock: (_key, body) => body,
    });
    const error = await failure(Effect.provideService(cacheVerifiedSource(verified), StateStore, service));
    expect(error).toMatchObject({ reason: "cache-failed" });
    for (const rendered of [JSON.stringify(error), String(error), Bun.inspect(error)])
      expect(rendered).not.toContain(privateValue);
    expect(error).not.toHaveProperty("cause");
  });
});
