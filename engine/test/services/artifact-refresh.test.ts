import { expect, test } from "bun:test";
import { Effect } from "effect";

import { ARTIFACT_REFRESH_EXTENSION, STOCK_TAG_REFRESH_AFTER_MS } from "@lando/sdk/schema";
import {
  acquireReferencedArtifact,
  decideArtifactPull,
  nextPullChecks,
  overduePullChecks,
  pullCheckKey,
  readArtifactRefreshAfterMs,
} from "../../src/services/artifact-refresh.ts";

const WEEK = STOCK_TAG_REFRESH_AFTER_MS;

test("a fresh local image is reused until the window elapses", () => {
  expect(
    decideArtifactPull({
      forced: false,
      refreshAfterMs: WEEK,
      localPresent: true,
      checkedAt: 0,
      now: WEEK - 1,
    }),
  ).toBe("reuse-local");
  expect(
    decideArtifactPull({
      forced: false,
      refreshAfterMs: WEEK,
      localPresent: true,
      checkedAt: 0,
      now: WEEK,
    }),
  ).toBe("refresh");
});

test("a missing image is pulled even when the check record is fresh", () => {
  expect(
    decideArtifactPull({
      forced: false,
      refreshAfterMs: WEEK,
      localPresent: false,
      checkedAt: WEEK,
      now: WEEK,
    }),
  ).toBe("missing");
});

test("rebuild forces a refresh and services without a window keep missing", () => {
  expect(
    decideArtifactPull({
      forced: true,
      refreshAfterMs: WEEK,
      localPresent: true,
      checkedAt: WEEK,
      now: WEEK,
    }),
  ).toBe("refresh");
  expect(
    decideArtifactPull({
      forced: false,
      refreshAfterMs: undefined,
      localPresent: true,
      checkedAt: undefined,
      now: 0,
    }),
  ).toBe("missing");
});

test("pull check keys include the runtime, not only the provider and reference", () => {
  const shared = { platform: "linux-x64", ref: "php:8.4-apache-bookworm" };
  expect(pullCheckKey({ ...shared, runtimeId: "unix:///run/podman.sock" })).not.toBe(
    pullCheckKey({ ...shared, runtimeId: "unix:///var/run/docker.sock" }),
  );
});

test("an older check does not overwrite a newer one", () => {
  const current = {
    key: {
      ref: "php:8.4-apache-bookworm",
      platform: "linux-x64",
      runtimeId: "runtime",
      checkedAt: 20,
      afterMs: WEEK,
    },
  };
  expect(nextPullChecks(current, "key", { ...current.key, checkedAt: 10 })).toBeUndefined();
  const updated = nextPullChecks(current, "key", { ...current.key, checkedAt: 30 });
  const row = updated?.key;
  if (row === undefined) throw new Error("expected a newer check to be stored");
  expect(row.checkedAt).toBe(30);
});

test("doctor overdue rows are the ones past their own window", () => {
  const checks = {
    fresh: { ref: "fresh", platform: "linux-x64", runtimeId: "runtime", checkedAt: 6, afterMs: 10 },
    due: { ref: "due", platform: "linux-x64", runtimeId: "runtime", checkedAt: 0, afterMs: 10 },
    other: { ref: "other", platform: "linux-x64", runtimeId: "elsewhere", checkedAt: 0, afterMs: 10 },
  };
  expect(overduePullChecks(checks, { runtimeId: "runtime", now: 10 }).map((check) => check.ref)).toEqual([
    "due",
  ]);
});

test("only a positive refresh extension is read", () => {
  expect(readArtifactRefreshAfterMs({ [ARTIFACT_REFRESH_EXTENSION]: { afterMs: WEEK } })).toBe(WEEK);
  expect(readArtifactRefreshAfterMs({})).toBeUndefined();
  expect(readArtifactRefreshAfterMs({ [ARTIFACT_REFRESH_EXTENSION]: { afterMs: 0 } })).toBeUndefined();
});

test("a due local image is refreshed and the check is recorded only after success", async () => {
  const policies: string[] = [];
  let recorded = 0;
  const result = await Effect.runPromise(
    acquireReferencedArtifact({
      pull: (policy) =>
        Effect.sync(() => {
          policies.push(policy);
          return policy;
        }),
      forced: false,
      refreshAfterMs: WEEK,
      checkedAt: 0,
      now: WEEK,
      onChecked: Effect.sync(() => {
        recorded += 1;
      }),
      onFallback: () => Effect.void,
    }),
  );
  expect(result).toBe("always");
  expect(policies).toEqual(["never", "always"]);
  expect(recorded).toBe(1);
});

test("a failed refresh keeps the local image and does not record a check", async () => {
  const policies: string[] = [];
  let recorded = 0;
  let warned = 0;
  const result = await Effect.runPromise(
    acquireReferencedArtifact({
      pull: (policy) => {
        policies.push(policy);
        return policy === "always" ? Effect.fail("offline") : Effect.succeed(policy);
      },
      forced: true,
      refreshAfterMs: WEEK,
      checkedAt: undefined,
      now: 0,
      onChecked: Effect.sync(() => {
        recorded += 1;
      }),
      onFallback: () =>
        Effect.sync(() => {
          warned += 1;
        }),
    }),
  );
  expect(result).toBe("never");
  expect(policies).toEqual(["always", "never"]);
  expect(recorded).toBe(0);
  expect(warned).toBe(1);
});
