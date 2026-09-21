import { expect, test } from "bun:test";
import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { buildKeyForService } from "../../src/services/build-key.ts";

/**
 * Mailpit's msmtp install carries the selected base family's pin record on the
 * build step's `buildKeyInputs`, so the artifact key follows a repin even when
 * the rendered command text is held constant. Only the selected family's
 * record is carried, which is what keeps one family's repin from invalidating
 * another family's images.
 */
type MsmtpStep = {
  readonly id: string;
  readonly phase: string;
  readonly command: string;
  readonly user: string;
  readonly buildKeyInputs: Readonly<Record<string, unknown>>;
};

const key = (buildSteps: ReadonlyArray<MsmtpStep>) => {
  const service: ServicePlan = {
    name: ServiceName.make("web"),
    type: "php:8.3",
    provider: ProviderId.make("test"),
    primary: true,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata: {
      resolvedAt: DateTime.unsafeMake("2026-09-18T00:00:00.000Z"),
      source: "build-key-msmtp.test",
      runtime: 4,
    },
    extensions: { "@lando/core/service-features": { buildSteps } },
  };
  return Effect.runPromise(buildKeyForService(TestRuntimeProvider, service));
};

const BOOKWORM = {
  family: "debian-bookworm",
  suite: "bookworm",
  snapshot: "20260101T000000Z",
  package: "msmtp",
  version: "1.8.23-1",
} as const;

const BULLSEYE = {
  family: "debian-bullseye",
  suite: "bullseye",
  snapshot: "20260101T000000Z",
  package: "msmtp",
  version: "1.8.11-2.1",
} as const;

const REPINNED_BOOKWORM = { ...BOOKWORM, snapshot: "20260601T000000Z", version: "1.8.23-2" } as const;

// Command text is deliberately identical across every step so any key
// difference is attributable to the pin record alone.
const step = (msmtp: Readonly<Record<string, unknown>>): MsmtpStep => ({
  id: "service-lando.php:mailpit",
  phase: "build",
  command: "install msmtp",
  user: "root",
  buildKeyInputs: { mailpit: { host: "mail", port: 1025 }, msmtp },
});

test("derives the same artifact key for an unchanged msmtp pin", async () => {
  // Given / When
  const [first, second] = await Promise.all([key([step(BOOKWORM)]), key([step(BOOKWORM)])]);
  // Then
  expect(first).toBe(second);
});

test("invalidates the artifact key when the selected family is repinned", async () => {
  // Given / When
  const [before, after] = await Promise.all([key([step(BOOKWORM)]), key([step(REPINNED_BOOKWORM)])]);
  // Then
  expect(before).not.toBe(after);
});

test("derives a different artifact key per base family", async () => {
  // Given / When
  const [bookworm, bullseye] = await Promise.all([key([step(BOOKWORM)]), key([step(BULLSEYE)])]);
  // Then
  expect(bookworm).not.toBe(bullseye);
});

test("leaves a bookworm image's key untouched when only bullseye is repinned", async () => {
  // Given a bookworm service planned before and after an unrelated bullseye repin.
  const repinnedBullseye = { ...BULLSEYE, snapshot: "20990101T000000Z", version: "9.9.9-1" };
  // When
  const [before, after, bullseyeBefore, bullseyeAfter] = await Promise.all([
    key([step(BOOKWORM)]),
    key([step(BOOKWORM)]),
    key([step(BULLSEYE)]),
    key([step(repinnedBullseye)]),
  ]);
  // Then
  expect(before).toBe(after);
  expect(bullseyeBefore).not.toBe(bullseyeAfter);
});
