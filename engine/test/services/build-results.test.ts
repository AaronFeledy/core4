import { describe, expect, test } from "bun:test";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";
import { BuildOwner } from "../../src/services/build-owner.ts";
import {
  type AppBuildResult,
  type ArtifactBuildResult,
  BuildResultEntry,
  clearAppBuildResults,
  findCompleteBuildResult,
  markBuildResultUsed,
  openAppBuildResults,
  openScratchBuildResults,
  recordBuildResult,
} from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const completedAt = DateTime.makeUnsafe("2026-07-12T15:00:00.000Z");
const requiredEntry = {
  buildKey: "a".repeat(64),
  service: ServiceName.make("web"),
  phase: "artifact",
  outcome: "complete",
  durationMs: 12,
  artifactRef: "web:test",
  transcriptPath: AbsolutePath.make("/tmp/lando/builds/web.log"),
  completedAt,
} as const;

const owner = BuildOwner.root(AbsolutePath.make("/tmp/myapp"));
function recorded(overrides: Partial<AppBuildResult> & { phase: "app"; step: string }): AppBuildResult;
function recorded(overrides: Partial<ArtifactBuildResult> & { phase?: "artifact" }): ArtifactBuildResult;
function recorded(
  overrides:
    | (Partial<AppBuildResult> & { phase: "app"; step: string })
    | (Partial<ArtifactBuildResult> & { phase?: "artifact" }),
): BuildResultEntry {
  if (overrides.phase === "app") {
    const { artifactRef: _, ...common } = requiredEntry;
    if (overrides.step === undefined) throw new TypeError("App fixture requires a step");
    return { ...common, ...overrides, phase: "app", step: overrides.step };
  }
  return { ...requiredEntry, ...overrides };
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("BuildResultEntry", () => {
  test("requires the transcript pointer and DateTimeUtc completion timestamp", () => {
    expect(Schema.is(BuildResultEntry)(requiredEntry)).toBe(true);
    const { transcriptPath: _, ...missingTranscript } = requiredEntry;
    expect(Schema.is(BuildResultEntry)(missingTranscript)).toBe(false);
    expect(
      Schema.is(BuildResultEntry)({
        ...requiredEntry,
        completedAt: "2026-07-12T15:00:00.000Z",
      }),
    ).toBe(false);
  });

  test("rejects an app step identity on an artifact entry", () => {
    expect(Schema.is(BuildResultEntry)(requiredEntry)).toBe(true);
    expect(Schema.is(BuildResultEntry)({ ...requiredEntry, step: "web:app:install" })).toBe(false);
  });

  test("returns the newest matching complete result", () => {
    const { artifactRef: _, ...older } = requiredEntry;
    const newer = { ...requiredEntry, artifactRef: "web:newer" };
    expect(
      findCompleteBuildResult([older, newer], {
        buildKey: requiredEntry.buildKey,
        service: requiredEntry.service,
        phase: requiredEntry.phase,
      }),
    ).toEqual(newer);
  });

  test("returns nothing when a newer matching attempt failed", () => {
    // Given
    const success = requiredEntry;
    const failure = { ...requiredEntry, outcome: "fail" as const };

    // When
    const found = findCompleteBuildResult([success, failure], {
      buildKey: requiredEntry.buildKey,
      service: requiredEntry.service,
      phase: requiredEntry.phase,
    });

    // Then
    expect(found).toBeUndefined();
  });

  test("returns a newer success recorded after a failure", () => {
    // Given
    const failure = { ...requiredEntry, outcome: "fail" as const };
    const success = { ...requiredEntry, artifactRef: "web:newer" };

    // When
    const found = findCompleteBuildResult([failure, success], {
      buildKey: requiredEntry.buildKey,
      service: requiredEntry.service,
      phase: requiredEntry.phase,
    });

    // Then
    expect(found).toEqual(success);
  });

  test("matches an app step only for its own step id", () => {
    const install = recorded({
      phase: "app",
      step: "web:app:install",
      containerId: "web-1",
    });
    const migrate = { ...install, step: "web:app:migrate" };

    expect(
      findCompleteBuildResult([install], {
        buildKey: requiredEntry.buildKey,
        service: requiredEntry.service,
        phase: "app",
        step: "web:app:migrate",
        containerId: "web-1",
      }),
    ).toBeUndefined();
    expect(
      findCompleteBuildResult([install, migrate], {
        buildKey: requiredEntry.buildKey,
        service: requiredEntry.service,
        phase: "app",
        step: "web:app:install",
        containerId: "web-1",
      }),
    ).toEqual(install);
  });

  test("replaces the earlier attempt for the same step identity and build key", async () => {
    // Given one app step that succeeds and then fails under the same build key.
    const store = makeTestStateStore();
    const bucket = await run(openAppBuildResults(store.service, owner));
    const entry = recorded({
      phase: "app",
      step: "web:app:install",
      buildKey: "key-1",
    });
    await run(recordBuildResult(bucket, entry));
    await run(recordBuildResult(bucket, { ...entry, outcome: "fail", exitCode: 1 }));

    // When
    const entries = await run(bucket.get);

    // Then
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({ buildKey: "key-1", outcome: "fail" });
  });

  test("keeps five build keys per step identity", async () => {
    // Given six recorded keys for one app step.
    const store = makeTestStateStore();
    const bucket = await run(openAppBuildResults(store.service, owner));
    for (let index = 1; index <= 6; index += 1) {
      await run(
        recordBuildResult(
          bucket,
          recorded({
            phase: "app",
            step: "web:app:install",
            buildKey: `key-${String(index)}`,
          }),
        ),
      );
    }

    // When
    const entries = await run(bucket.get);

    // Then the five most recently recorded keys remain.
    expect(entries?.map((entry) => entry.buildKey)).toEqual(["key-2", "key-3", "key-4", "key-5", "key-6"]);
  });

  test("keeps the current key of every app step of one service", async () => {
    // Given six app steps that each recorded one key.
    const store = makeTestStateStore();
    const bucket = await run(openAppBuildResults(store.service, owner));
    for (let index = 1; index <= 6; index += 1) {
      await run(
        recordBuildResult(
          bucket,
          recorded({
            phase: "app",
            step: `web:app:${String(index)}`,
            buildKey: `key-${String(index)}`,
          }),
        ),
      );
    }

    // When
    const entries = await run(bucket.get);

    // Then a distinct step identity is its own rotation scope.
    expect(entries).toHaveLength(6);
    expect(entries?.map((entry) => entry.step)).toEqual([
      "web:app:1",
      "web:app:2",
      "web:app:3",
      "web:app:4",
      "web:app:5",
      "web:app:6",
    ]);
  });

  test("keeps a step's newest entry when other steps fill the overall cap", async () => {
    // Given one step that recorded a single key and never ran again.
    const store = makeTestStateStore();
    const bucket = await run(openScratchBuildResults(store.service));
    await run(
      recordBuildResult(bucket, recorded({ phase: "app", step: "web:app:install", buildKey: "stable" })),
    );

    // And 101 other step identities whose five keys each push the index past 500 entries.
    for (let step = 0; step < 101; step += 1) {
      for (let key = 0; key < 5; key += 1) {
        await run(
          recordBuildResult(
            bucket,
            recorded({
              phase: "app",
              service: ServiceName.make(`svc-${String(step)}`),
              step: `svc-${String(step)}:app:install`,
              buildKey: `key-${String(step)}-${String(key)}`,
            }),
          ),
        );
      }
    }

    // When
    const entries = await run(bucket.get);

    // Then the cap evicts older keys of other steps, never the unchanged step's newest entry.
    expect(entries).toHaveLength(500);
    expect(entries?.some((entry) => entry.buildKey === "stable")).toBe(true);
  });

  test("caps the index at the newest 500 entries", async () => {
    // Given 501 recorded results whose identities are all distinct.
    const store = makeTestStateStore();
    const bucket = await run(openScratchBuildResults(store.service));
    await run(
      Effect.forEach(
        Array.from({ length: 501 }, (_, index) => index),
        (index) =>
          recordBuildResult(bucket, {
            ...recorded({}),
            service: ServiceName.make(`svc-${String(index)}`),
            buildKey: `entry-${String(index)}`,
          }),
        { discard: true },
      ),
    );

    // When
    const entries = await run(bucket.get);

    // Then
    expect(entries).toHaveLength(500);
    expect(entries?.[0]?.buildKey).toBe("entry-1");
    expect(entries?.at(-1)?.buildKey).toBe("entry-500");
    expect(entries?.map((entry) => entry.buildKey)).toEqual(
      Array.from({ length: 500 }, (_, index) => `entry-${index + 1}`),
    );
  });
});

describe("clearAppBuildResults", () => {
  test("keeps artifact results and removes app-phase results", async () => {
    // Given an app index with one artifact and one app result.
    const store = makeTestStateStore();
    const bucket = await run(openAppBuildResults(store.service, owner));
    await run(recordBuildResult(bucket, recorded({})));
    await run(
      recordBuildResult(bucket, recorded({ phase: "app", step: "web:app:install", buildKey: "app-key" })),
    );

    // When
    await run(clearAppBuildResults(store.service, owner));

    // Then only the image result that survives destroy is left.
    const entries = await run(bucket.get);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({ phase: "artifact", buildKey: requiredEntry.buildKey });
  });

  test("removes the bucket when only app-phase results remain", async () => {
    // Given an app index with only app results.
    const store = makeTestStateStore();
    const bucket = await run(openAppBuildResults(store.service, owner));
    await run(
      recordBuildResult(bucket, recorded({ phase: "app", step: "web:app:install", buildKey: "app-key" })),
    );

    // When
    await run(clearAppBuildResults(store.service, owner));

    // Then the file is gone instead of holding an empty tombstone.
    expect(await run(bucket.exists)).toBe(false);
  });
});

describe("markBuildResultUsed", () => {
  const appEntry = (buildKey: string) =>
    recorded({
      phase: "app",
      step: "web:app:install",
      buildKey,
      transcriptPath: AbsolutePath.make(`/tmp/${buildKey}.log`),
    });

  test("moves a reused entry to the newest position of its step identity", async () => {
    // Given an older key that precedes a newer key of the same app step.
    const store = makeTestStateStore();
    const bucket = await run(openAppBuildResults(store.service, owner));
    await run(recordBuildResult(bucket, appEntry("older")));
    await run(recordBuildResult(bucket, appEntry("newer")));
    const before = await run(bucket.get);
    const older = before?.find((entry) => entry.buildKey === "older");
    if (older === undefined) throw new TypeError("older entry is missing");

    // When
    await run(markBuildResultUsed(bucket, older));

    // Then
    const after = await run(bucket.get);
    expect(after?.map((entry) => entry.buildKey)).toEqual(["newer", "older"]);
    expect(after?.at(-1)?.completedAt).toEqual(older.completedAt);
  });

  test("keeps a reused key through the later recordings that would otherwise evict it", async () => {
    // Given five keys where the oldest is the one in use.
    const store = makeTestStateStore();
    const bucket = await run(openAppBuildResults(store.service, owner));
    for (const key of ["k1", "k2", "k3", "k4", "k5"]) {
      await run(recordBuildResult(bucket, appEntry(key)));
    }
    const entries = await run(bucket.get);
    const used = entries?.find((entry) => entry.buildKey === "k1");
    if (used === undefined) throw new TypeError("used entry is missing");
    await run(markBuildResultUsed(bucket, used));

    // When four later keys are recorded, which would have evicted the oldest unused key.
    for (const key of ["k6", "k7", "k8", "k9"]) {
      await run(recordBuildResult(bucket, appEntry(key)));
    }

    // Then the used key is still one of the five retained keys.
    const after = await run(bucket.get);
    expect(after?.map((entry) => entry.buildKey)).toEqual(["k1", "k6", "k7", "k8", "k9"]);
  });

  test("does not write when the reused entry is already newest", async () => {
    // Given a bucket whose newest entry of the identity is the one being reused.
    const store = makeTestStateStore();
    const bucket = await run(openAppBuildResults(store.service, owner));
    await run(recordBuildResult(bucket, appEntry("older")));
    await run(recordBuildResult(bucket, appEntry("newest")));
    const entries = await run(bucket.get);
    const used = entries?.find((entry) => entry.buildKey === "newest");
    if (used === undefined) throw new TypeError("newest entry is missing");
    const before = await run(store.readRaw(bucket.path));
    expect(before).not.toBeNull();

    // When
    await run(markBuildResultUsed(bucket, used));

    // Then the stored bytes are untouched.
    expect(await run(store.readRaw(bucket.path))).toEqual(before);
  });
});
