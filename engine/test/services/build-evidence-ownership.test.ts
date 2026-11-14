import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { BuildOrchestrator, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema, Stream } from "effect";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import {
  BuildOwner,
  clearAppBuildResults,
  openAppBuildResults,
  openScratchBuildResults,
} from "../../src/services/build-results.ts";
import {
  removeBuildTranscripts,
  sweepAppBuildTranscripts,
} from "../../src/services/build-transcript-cleanup.ts";
import { makeLayer, planWith, withTempRoots } from "./build-app-runner-test-support.ts";

test("#2291 same-name canonical roots never reuse each other's app receipt", async () => {
  await withTempRoots(async () => {
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
        Effect.succeed({
          app: target.app,
          service: target.service,
          providerId: ProviderId.make(TestRuntimeProvider.id),
          status: "running" as const,
          publications: { status: "unknown" as const },
          containerId: "native-1",
        }),
      execStream: () => {
        calls.push("install");
        return Stream.make({ exitCode: 0 });
      },
    };
    const base = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });
    const root = process.env.LANDO_USER_DATA_ROOT;
    if (root === undefined) throw new TypeError("Test data root is missing");
    const a = { ...base, root: AbsolutePath.make(join(root, "a")) };
    const b = { ...base, root: AbsolutePath.make(join(root, "b")) };
    await mkdir(a.root);
    await mkdir(b.root);

    const receipts = await Effect.runPromise(
      Effect.gen(function* () {
        const build = yield* BuildOrchestrator;
        yield* build.buildApp(a);
        yield* build.buildApp(b);
        yield* build.buildApp(a);
        const state = yield* StateStore;
        const bucketA = yield* openAppBuildResults(state, BuildOwner.fromPlan(a));
        const bucketB = yield* openAppBuildResults(state, BuildOwner.fromPlan(b));
        return { a: yield* bucketA.get, b: yield* bucketB.get, pathA: bucketA.path, pathB: bucketB.path };
      }).pipe(Effect.provide(makeLayer(provider))),
    );

    expect(calls).toEqual(["install", "install"]);
    expect(receipts.a).toHaveLength(1);
    expect(receipts.b).toHaveLength(1);
    expect(receipts.pathA).not.toBe(receipts.pathB);
    expect(receipts.a?.[0]?.transcriptPath).not.toBe(receipts.b?.[0]?.transcriptPath);
  });
});

test("scratch instances isolate app output while retaining shared artifact evidence", async () => {
  await withTempRoots(async () => {
    const base = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });
    const a = {
      ...base,
      id: AppId.make("scratch-a"),
      extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-a" } },
    };
    const b = {
      ...base,
      id: AppId.make("scratch-b"),
      extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-b" } },
    };
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.make({ exitCode: 0 }),
      pullArtifact: ({ ref }: { readonly ref: string }) =>
        Effect.succeed({ providerId: base.provider, ref, digest: "sha256:source" }),
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const build = yield* BuildOrchestrator;
        const state = yield* StateStore;
        yield* build.build(a);
        yield* build.build(b);
        yield* build.buildApp(a);
        yield* build.buildApp(b);
        const bucketA = yield* openAppBuildResults(state, BuildOwner.fromPlan(a));
        const bucketB = yield* openAppBuildResults(state, BuildOwner.fromPlan(b));
        const beforeA = yield* bucketA.get;
        const beforeB = yield* bucketB.get;
        yield* clearAppBuildResults(state, BuildOwner.fromPlan(a));
        const shared = yield* openScratchBuildResults(state);
        return { beforeA, beforeB, afterB: yield* bucketB.get, artifacts: yield* shared.get };
      }).pipe(Effect.provide(makeLayer(provider))),
    );

    expect(result.beforeA).toHaveLength(1);
    expect(result.beforeB).toHaveLength(1);
    expect(result.beforeA?.[0]?.transcriptPath).toContain(join("builds", "scratch", "scratch-a"));
    expect(result.beforeB?.[0]?.transcriptPath).toContain(join("builds", "scratch", "scratch-b"));
    expect(result.afterB).toEqual(result.beforeB);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts?.[0]).toMatchObject({ phase: "artifact", artifactRef: "test/web:latest" });
  });
});

test("owner sweep and successful cleanup preserve another root and unattributable legacy bytes", async () => {
  await withTempRoots(async () => {
    const data = process.env.LANDO_USER_DATA_ROOT;
    const cache = process.env.LANDO_USER_CACHE_ROOT;
    if (data === undefined || cache === undefined) throw new TypeError("Missing test roots");
    const base = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });
    const a = { ...base, root: AbsolutePath.make(join(data, "a")) };
    const b = { ...base, root: AbsolutePath.make(join(data, "b")) };
    await mkdir(a.root);
    await mkdir(b.root);
    const owner = BuildOwner.fromPlan(a);
    const legacyLog = join(data, "builds", a.id, "app", "web", "legacy.log");
    const legacyHashLog = join(data, "builds", owner.key, "app", "web", "legacy.log");
    for (const path of [legacyLog, legacyHashLog]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "unattributable legacy bytes");
    }
    const provider = {
      ...TestRuntimeProvider,
      execStream: () =>
        Stream.make(
          { kind: "stdout" as const, chunk: new TextEncoder().encode("owned output\n") },
          { exitCode: 0 },
        ),
    };
    const stale = join(data, "builds", "owners", owner.key, "app", "web", "stale.log");

    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const build = yield* BuildOrchestrator;
        const stateStore = yield* StateStore;
        const legacy = yield* Effect.forEach([String(a.id), owner.key], (name) =>
          Effect.gen(function* () {
            const bucket = yield* stateStore.open({
              root: "userCache",
              namespace: "build-results",
              key: `${name}.bin`,
              schema: Schema.Unknown,
              version: 3,
              codec: "binary",
              lock: "advisory",
              onCorrupt: "quarantine",
              onVersionMismatch: "discard",
              default: [],
            });
            yield* bucket.set([
              {
                buildKey: "legacy",
                service: "web",
                phase: "app",
                outcome: "complete",
                exitCode: 0,
                durationMs: 1,
                transcriptPath: legacyLog,
                completedAt: "2026-07-17T00:00:00.000Z",
              },
            ]);
            return { path: bucket.path, bytes: yield* Effect.promise(() => readFile(bucket.path)) };
          }),
        );
        yield* build.buildApp(a);
        yield* build.buildApp(b);
        yield* Effect.promise(() => writeFile(stale, "stale"));
        yield* sweepAppBuildTranscripts({
          userDataRoot: data,
          owner,
          phase: "app",
          stateStore,
          redact: (text) => text,
        });
        const swept = yield* Effect.promise(() => Bun.file(stale).exists());
        yield* clearAppBuildResults(stateStore, owner);
        yield* removeBuildTranscripts({ userDataRoot: data, owner });
        const bucketB = yield* openAppBuildResults(stateStore, BuildOwner.fromPlan(b));
        return { swept, entries: yield* bucketB.get, legacy };
      }).pipe(Effect.provide(makeLayer(provider))),
    );

    expect(remaining.swept).toBe(false);
    expect(remaining.entries).toHaveLength(1);
    const transcript = remaining.entries?.[0]?.transcriptPath;
    if (transcript === undefined) throw new TypeError("B transcript missing");
    expect(await readFile(transcript, "utf8")).toBe("owned output\n");
    for (const path of [legacyLog, legacyHashLog])
      expect(await readFile(path, "utf8")).toBe("unattributable legacy bytes");
    for (const { path, bytes } of remaining.legacy) expect(await readFile(path)).toEqual(bytes);
    expect(BuildOwner.fromPlan({ ...a, id: AppId.make("renamed") }).key).toBe(owner.key);
  });
});
