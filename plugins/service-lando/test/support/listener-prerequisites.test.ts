import { expect, test } from "bun:test";
import { assertListenerCompletion, listenerPrerequisites } from "./listener-prerequisites.ts";

test("collects all absent explicit prerequisites when unconfigured", () => {
  // Given / When: no opt-ins, regardless of an installed managed runtime.
  const missing = listenerPrerequisites({ socket: false, binary: undefined, image: undefined });
  // Then: callers can report every missing prerequisite together.
  expect(missing).toHaveLength(3);
});

test("requires no local skips when all explicit prerequisites exist", () => {
  // Given / When / Then: configured failures belong to execution, not skip logic.
  expect(listenerPrerequisites({ socket: true, binary: "/tmp/lando", image: "localhost/qa:minio" })).toEqual(
    [],
  );
});

test.each([
  { completed: [] },
  { completed: ["mailpit-default"] },
  { completed: ["mailpit-default", "mailpit-moved", "minio-default", "minio-default"] },
])("rejects incomplete or duplicated completion evidence %j", ({ completed }) => {
  // Given / When / Then: neither all-skipped nor duplicate cases satisfy strict acceptance.
  expect(() => assertListenerCompletion(completed)).toThrow("incomplete");
});

test("accepts completion evidence when all four distinct journeys finished", () => {
  // Given / When / Then: exact set completion, independent of ordering.
  expect(() =>
    assertListenerCompletion(["minio-moved", "mailpit-default", "minio-default", "mailpit-moved"]),
  ).not.toThrow();
});
