import { expect, test } from "bun:test";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import {
  BuildOwner,
  BuildResultEntry,
  openAppBuildResults,
  recordBuildResult,
} from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const common = {
  buildKey: "key",
  service: "web",
  outcome: "complete",
  durationMs: 1,
  transcriptPath: "/tmp/build.log",
  completedAt: "2026-07-17T00:00:00.000Z",
} as const;

test("app evidence preserves an absent command exit and container identity", () => {
  const decoded = Schema.decodeUnknownSync(BuildResultEntry)({ ...common, phase: "app", step: "install" });
  expect(decoded).toMatchObject({ phase: "app", step: "install" });
  expect(Object.hasOwn(decoded, "exitCode")).toBe(false);
  expect(Object.hasOwn(decoded, "containerId")).toBe(false);
});

for (const fields of [
  { phase: "app", exitCode: 0 },
  { phase: "app", step: "install", exitCode: 0, artifactRef: "image:latest" },
  { phase: "artifact", step: "install" },
  { phase: "artifact", containerId: "native-1" },
  { phase: "artifact", invalidated: true },
  { phase: "artifact", exitCode: 0 },
]) {
  test(`rejects contradictory phase evidence ${JSON.stringify(fields)}`, () => {
    expect(() => Schema.decodeUnknownSync(BuildResultEntry)({ ...common, ...fields })).toThrow();
  });
}

test("artifact provenance round-trips without app fields", () => {
  const encoded = {
    ...common,
    phase: "artifact",
    artifactRef: "web:built",
    artifactOrigin: "build",
    sourceArtifactRef: "web:source",
    sourceArtifactDigest: "sha256:source",
  } as const;
  const decoded = Schema.decodeUnknownSync(BuildResultEntry)(encoded);
  expect(Schema.encodeSync(BuildResultEntry)(decoded)).toEqual(encoded);
});

test("StateStore discards a v3 payload at the current owner bucket location", async () => {
  const store = makeTestStateStore();
  const owner = BuildOwner.root(AbsolutePath.make("/tmp/cache-owner"));
  const old = await Effect.runPromise(
    store.service.open({
      root: "userCache",
      namespace: "build-results-owned",
      key: `root-${owner.key}.bin`,
      schema: Schema.Unknown,
      version: 3,
      codec: "binary",
      lock: "advisory",
      onCorrupt: "quarantine",
      onVersionMismatch: "discard",
      default: [],
    }),
  );
  await Effect.runPromise(old.set([{ ...common, phase: "app", exitCode: 0 }]));

  const current = await Effect.runPromise(openAppBuildResults(store.service, owner));
  expect(await Effect.runPromise(current.get)).toEqual([]);
  const { completedAt: _, ...fresh } = Schema.decodeUnknownSync(BuildResultEntry)({
    ...common,
    phase: "app",
    step: "install",
  });
  await Effect.runPromise(recordBuildResult(current, fresh));
  expect(await Effect.runPromise(current.get)).toMatchObject([{ phase: "app", step: "install" }]);
  const bytes = await Effect.runPromise(store.readRaw(current.path));
  if (bytes === null) throw new TypeError("Missing current cache bytes");
  expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4)).toBe(4);
});
