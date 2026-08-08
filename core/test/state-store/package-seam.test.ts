import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, type AbsolutePath as AbsolutePathType } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";

const ValueSchema = Schema.Struct({ value: Schema.String });
const PackageManifestSchema = Schema.Struct({
  name: Schema.String,
  private: Schema.Boolean,
  workspaces: Schema.optional(Schema.Array(Schema.String)),
  dependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  devDependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  peerDependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});

type StateStoreServiceModule = typeof import("@lando/state-store/service");

const isRuntimeModule = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isStateStoreServiceModule = (value: unknown): value is StateStoreServiceModule =>
  isRuntimeModule(value) &&
  "makeStateStore" in value &&
  typeof value.makeStateStore === "function" &&
  "StateStoreLive" in value;

const repositoryRoot = new URL("../../../", import.meta.url);
const pluginDirectory = new URL("../../../plugins/provider-lando/", import.meta.url).pathname;
const stateStoreManifestUrl = new URL("state-store/package.json", repositoryRoot);

const parseManifest = async (url: URL) => {
  const manifest: unknown = await Bun.file(url).json();
  return Schema.decodeUnknownSync(PackageManifestSchema)(manifest);
};

let root: AbsolutePathType;

beforeEach(async () => {
  root = Schema.decodeUnknownSync(AbsolutePath)(await mkdtemp(join(tmpdir(), "lando-state-package-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("StateStore package seam", () => {
  test("exports a usable private StateStore implementation package", async () => {
    // Given the workspace artifacts and a package resolution rooted in a real plugin directory
    const artifactExists = await Bun.file(stateStoreManifestUrl).exists();
    const packageManifest = await parseManifest(stateStoreManifestUrl);
    const rootManifest = await parseManifest(new URL("package.json", repositoryRoot));
    const coreManifest = await parseManifest(new URL("core/package.json", repositoryRoot));
    const servicePath = Bun.resolveSync("@lando/state-store/service", pluginDirectory);
    const serviceModule: unknown = await import("@lando/state-store/service");
    if (!isStateStoreServiceModule(serviceModule)) {
      throw new TypeError("@lando/state-store/service does not expose the expected runtime API");
    }
    const bucket = await Effect.runPromise(
      serviceModule
        .makeStateStore()
        .open({ root: { path: root }, key: "value.json", schema: ValueSchema, version: 1 }),
    );

    // When the dynamically resolved package implementation writes and reads the bucket
    const value = await Effect.runPromise(bucket.set({ value: "package" }).pipe(Effect.zipRight(bucket.get)));

    // Then package metadata, plugin resolution, and the durable round trip satisfy the private seam
    expect(artifactExists).toBe(true);
    expect(packageManifest.name).toBe("@lando/state-store");
    expect(packageManifest.private).toBe(true);
    expect(rootManifest.workspaces).toContain("state-store");
    expect(coreManifest.dependencies?.["@lando/state-store"]).toBe("workspace:*");
    expect(servicePath).toContain("state-store/src/service.ts");
    expect(value).toEqual({ value: "package" });
  });

  test("keeps contracts in the SDK and rejects an escaping key", async () => {
    // Given package and SDK modules resolved from the same real plugin directory
    const packageManifest = await parseManifest(stateStoreManifestUrl);
    const serviceModule: unknown = await import("@lando/state-store/service");
    if (!isStateStoreServiceModule(serviceModule)) {
      throw new TypeError("@lando/state-store/service does not expose the expected runtime API");
    }
    const service = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* StateStore;
      }).pipe(Effect.provide(serviceModule.StateStoreLive)),
    );

    // When a bucket key attempts to escape its assigned root
    const error = await Effect.runPromise(
      service
        .open({ root: { path: root }, key: "../escape.json", schema: ValueSchema, version: 1 })
        .pipe(Effect.flip),
    );

    // Then no manifest dependency points to core and the exact SDK error contract is returned
    expect(packageManifest.dependencies?.["@lando/core"]).toBeUndefined();
    expect(packageManifest.devDependencies?.["@lando/core"]).toBeUndefined();
    expect(packageManifest.peerDependencies?.["@lando/core"]).toBeUndefined();
    expect(error).toBeInstanceOf(StateStoreError);
    expect(error.reason).toBe("path");
  });

  test("preserves legacy core module identities through package shims", async () => {
    // Given dynamically imported package subpaths and their legacy core shims
    const packageService: unknown = await import("@lando/state-store/service");
    const packageCodec: unknown = await import("@lando/state-store/codec");
    const packageLock: unknown = await import("@lando/state-store/lock");
    const packagePaths: unknown = await import("@lando/state-store/paths");
    const packageAtomic: unknown = await import("@lando/state-store/atomic");
    const legacyService: unknown = await import("@lando/engine/state/service");
    const legacyCodec: unknown = await import("@lando/engine/state/codec");
    const legacyLock: unknown = await import("@lando/engine/state/lock");
    const legacyPaths: unknown = await import("@lando/engine/state/paths");
    const legacyAtomic: unknown = await import("@lando/engine/state-store/atomic");
    const modulePairs = [
      [legacyService, packageService],
      [legacyCodec, packageCodec],
      [legacyLock, packageLock],
      [legacyPaths, packagePaths],
      [legacyAtomic, packageAtomic],
    ] as const;

    // When each shim's runtime export surface and references are compared
    const comparisons = modulePairs.map(([legacy, current]) => {
      if (!isRuntimeModule(legacy) || !isRuntimeModule(current)) {
        throw new TypeError("StateStore package and shim imports must be runtime modules");
      }
      const legacyKeys = Object.keys(legacy).sort();
      const currentKeys = Object.keys(current).sort();
      return {
        currentKeys,
        identities: legacyKeys.map((key) => Reflect.get(legacy, key) === Reflect.get(current, key)),
        legacyKeys,
      };
    });

    // Then no shim is empty and every export key and runtime reference is identical
    for (const comparison of comparisons) {
      expect(comparison.legacyKeys.length).toBeGreaterThan(0);
      expect(comparison.legacyKeys).toEqual(comparison.currentKeys);
      expect(comparison.identities).not.toContain(false);
    }
  });
});
