import { expect, test } from "bun:test";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { artifactBuildName, artifactBuildStoreKey } from "../../src/services/build-artifact-name.ts";
import {
  type ArtifactBuildResult,
  claimArtifactBuild,
  openArtifactBuildResults,
  recordArtifactBuildResult,
  removeArtifactBuildResults,
  rotateArtifactBuildResults,
  settleArtifactBuildClaim,
  useArtifactBuildResult,
} from "../../src/services/build-artifact-results.ts";
import { BuildOwner } from "../../src/services/build-owner.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const owner = BuildOwner.root(AbsolutePath.make("/tmp/artifact-owner"));
const now = DateTime.makeUnsafe("2026-11-14T00:00:00Z");
const entry = (buildKey: string): ArtifactBuildResult => ({
  owner: owner.key,
  providerId: "test",
  phase: "artifact",
  service: ServiceName.make("web"),
  buildKey,
  artifactRef: `lando-build-${buildKey}`,
  artifactOrigin: "build",
  outcome: "complete",
  durationMs: 1,
  transcriptPath: AbsolutePath.make(`/tmp/${buildKey}.log`),
  completedAt: now,
});
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    TestClock.setTime(DateTime.toEpochMillis(now)).pipe(
      Effect.andThen(effect),
      Effect.provide(TestClock.layer()),
    ),
  );

test("rotation isolates providers and scratch ids and keeps five newest keys per writing identity", () => {
  const scratch = BuildOwner.scratch(AppId.make("scratch-a"));
  const foreign = {
    ...entry("foreign"),
    owner: BuildOwner.scratch(AppId.make("scratch-b")).key,
  };
  const otherProvider = { ...entry("other-provider"), providerId: "docker", owner: scratch.key };
  const rotated = rotateArtifactBuildResults(
    [foreign, otherProvider, ...[1, 2, 3, 4, 5, 6].map((i) => ({ ...entry(String(i)), owner: scratch.key }))],
    scratch.key,
    now,
  );
  expect(rotated.entries.map((item) => item.buildKey)).toEqual([
    "foreign",
    "other-provider",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);
  expect(rotated.dropped.map((item) => item.buildKey)).toEqual(["1"]);
});

test("data-root backstop preserves each identity's newest result while evicting older keys", () => {
  const stable = { ...entry("stable"), service: ServiceName.make("stable") };
  const results = [
    stable,
    ...Array.from({ length: 401 }, (_, service) =>
      Array.from({ length: 5 }, (_, key) => ({
        ...entry(`${service}-${key}`),
        service: ServiceName.make(`service-${service}`),
      })),
    ).flat(),
  ];
  const rotated = rotateArtifactBuildResults(results, owner.key, now);
  expect(rotated.entries).toHaveLength(2000);
  expect(rotated.entries).toContain(stable);
  for (let service = 0; service < 401; service += 1)
    expect(rotated.entries.some((item) => item.buildKey === `${service}-4`)).toBe(true);
});

test("every owner's write expires released history and caps it at the ten most recently released", () => {
  const expired = { ...entry("expired"), releasedAt: DateTime.makeUnsafe("2026-11-06T23:59:59Z") };
  const recent = Array.from({ length: 12 }, (_, i) => ({
    ...entry(String(i)),
    owner: `owner-${i}`,
    releasedAt: DateTime.makeUnsafe(`2026-11-13T00:00:${String(i).padStart(2, "0")}Z`),
  }));
  const rotated = rotateArtifactBuildResults([expired, ...recent.toReversed()], "unrelated", now);
  expect(rotated.entries.map((item) => item.buildKey)).toEqual([
    "11",
    "10",
    "9",
    "8",
    "7",
    "6",
    "5",
    "4",
    "3",
    "2",
  ]);
  expect(rotated.dropped.map((item) => item.buildKey)).toEqual(["expired", "1", "0"]);
});

test("refresh and concurrent same-key builds hold separate claims and settle only their own", async () => {
  const bucket = await run(openArtifactBuildResults(makeTestStateStore().service));
  await run(recordArtifactBuildResult(bucket, entry("same")));
  const first = await run(claimArtifactBuild(bucket, entry("same")));
  const second = await run(claimArtifactBuild(bucket, entry("same")));
  expect(first.claim.id).not.toBe(second.claim.id);
  expect((await run(bucket.get))?.claims.map((claim) => claim.id)).toEqual([first.claim.id, second.claim.id]);
  await run(recordArtifactBuildResult(bucket, { ...entry("same"), outcome: "fail" }));
  await run(settleArtifactBuildClaim(bucket, first.claim.id));
  expect((await run(bucket.get))?.claims.map((claim) => claim.id)).toEqual([second.claim.id]);
  expect((await run(bucket.get))?.results).toMatchObject([{ outcome: "fail" }]);
  await run(settleArtifactBuildClaim(bucket, second.claim.id));
  expect((await run(bucket.get))?.claims).toEqual([]);
});

test("all index writers discard dead-pid claims and retain live ones", async () => {
  const bucket = await run(openArtifactBuildResults(makeTestStateStore().service));
  const live = { id: "live", providerId: "test", artifactRef: "live", pid: process.pid, claimedAt: now };
  const dead = { ...live, id: "dead", pid: 2_147_483_647 };
  await run(bucket.set({ results: [], claims: [live, dead] }));
  await run(recordArtifactBuildResult(bucket, entry("new")));
  expect((await run(bucket.get))?.claims).toEqual([live]);
});

test("recording replaces a key and returns replaced and rotated results", async () => {
  const bucket = await run(openArtifactBuildResults(makeTestStateStore().service));
  await run(bucket.set({ results: [1, 2, 3, 4, 5].map((i) => entry(String(i))), claims: [] }));
  expect((await run(recordArtifactBuildResult(bucket, entry("6")))).map((item) => item.buildKey)).toEqual([
    "1",
  ]);
  expect(
    (await run(recordArtifactBuildResult(bucket, { ...entry("6"), outcome: "fail" }))).map(
      (item) => item.buildKey,
    ),
  ).toEqual(["6"]);
  expect((await run(bucket.get))?.results.at(-1)).toMatchObject({ buildKey: "6", outcome: "fail" });
  expect(await run(useArtifactBuildResult(bucket, entry("6")))).toBeUndefined();
});

test.each([false, true])(
  "cross-owner reuse copies a live result and moves a released result (released=%s)",
  async (released) => {
    const bucket = await run(openArtifactBuildResults(makeTestStateStore().service));
    const source = { ...entry("key"), ...(released ? { releasedAt: now } : {}) };
    const failed = { ...entry("key"), owner: "requester", outcome: "fail" as const };
    await run(bucket.set({ results: [source, failed], claims: [] }));
    const hit = await run(useArtifactBuildResult(bucket, { ...source, owner: "requester" }));
    expect(hit?.entry).toMatchObject({
      owner: "requester",
      buildKey: "key",
      artifactRef: source.artifactRef,
    });
    expect(hit?.entry.releasedAt).toBeUndefined();
    expect(hit?.dropped).toEqual([failed]);
    expect((await run(bucket.get))?.results.map((item) => item.owner)).toEqual(
      released ? ["requester"] : [owner.key, "requester"],
    );
  },
);

test("reuse prefers the owner's complete result, touches last use, and misses vanished keys", async () => {
  const bucket = await run(openArtifactBuildResults(makeTestStateStore().service));
  await run(
    bucket.set({
      results: [entry("key"), { ...entry("key"), owner: "other", artifactRef: "other-ref" }],
      claims: [],
    }),
  );
  const hit = await run(useArtifactBuildResult(bucket, entry("key")));
  expect(hit?.entry.artifactRef).toBe("lando-build-key");
  expect((await run(bucket.get))?.results.at(-1)?.owner).toBe(owner.key);
  await run(bucket.remove);
  expect(await run(useArtifactBuildResult(bucket, entry("key")))).toBeUndefined();
});

test("release retains only the newest produced complete image per provider and purge removes prior releases", async () => {
  const bucket = await run(openArtifactBuildResults(makeTestStateStore().service));
  const lastUsed = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
  const results = [
    { ...entry("old"), completedAt: DateTime.makeUnsafe("2026-09-30T00:00:00Z") },
    { ...entry("new"), completedAt: lastUsed },
    { ...entry("failure"), outcome: "fail" as const },
    { ...entry("other-provider"), providerId: "other" },
    { ...entry("foreign"), owner: "foreign" },
  ];
  await run(bucket.set({ results, claims: [] }));
  expect(
    await run(removeArtifactBuildResults(bucket, owner, { images: "release", providerId: "test" })),
  ).toEqual({ providerIds: ["test"], released: 1, releasedOwners: [`${owner.key}\0test`] });
  const released = (await run(bucket.get))?.results;
  expect(released?.map((item) => item.buildKey)).toEqual(["other-provider", "foreign", "new"]);
  expect(released?.at(-1)).toMatchObject({
    owner: owner.key,
    completedAt: lastUsed,
    releasedAt: now,
  });
  await run(removeArtifactBuildResults(bucket, owner, { images: "remove", providerId: "test" }));
  expect((await run(bucket.get))?.results.map((item) => item.buildKey)).toEqual([
    "other-provider",
    "foreign",
  ]);
});

test("engine image names differ between canonical cache roots and satisfy image name limits", async () => {
  const a = await run(artifactBuildStoreKey("/tmp/lando-cache-one"));
  const b = await run(artifactBuildStoreKey("/tmp/lando-cache-two"));
  const first = artifactBuildName(a, "Provider/UPPER_...", "SERVICE".repeat(40), "a".repeat(64));
  expect(first).not.toBe(artifactBuildName(b, "Provider/UPPER_...", "SERVICE".repeat(40), "a".repeat(64)));
  expect(first).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  expect(first.length).toBeLessThanOrEqual(255);
});
