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
});
