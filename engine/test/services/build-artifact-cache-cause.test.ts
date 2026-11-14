import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, DateTime, Effect, Exit } from "effect";
import { producedImagePresent } from "../../src/services/build-artifact-cache.ts";
import type { ArtifactBuildResult } from "../../src/services/build-results.ts";

const complete: ArtifactBuildResult = {
  phase: "artifact",
  buildKey: "produced-image-key",
  service: ServiceName.make("web"),
  outcome: "complete",
  durationMs: 1,
  transcriptPath: AbsolutePath.make("/tmp/produced-image-build.log"),
  completedAt: DateTime.makeUnsafe("2026-11-13T00:00:00Z"),
  artifactOrigin: "build",
  artifactRef: "web:produced",
};
const failure = new ProviderUnavailableError({
  providerId: "test",
  operation: "pullArtifact",
  message: "Produced image is unavailable locally.",
  remediation: "Rebuild the image.",
});
const defect = new TypeError("image lookup cleanup failed");
const fiberId = 2297;

describe("producedImagePresent Cause recovery", () => {
  test("returns a cache hit when the produced image lookup succeeds", async () => {
    const provider = {
      ...TestRuntimeProvider,
      pullArtifact: () => Effect.succeed({ providerId: ProviderId.make("test"), ref: "web:produced" }),
    };

    const exit = await Effect.runPromiseExit(producedImagePresent(provider, complete));

    expect(exit).toEqual(Exit.succeed(true));
  });

  test.each([
    ["one typed failure", Cause.fail(failure)],
    [
      "multiple typed failures",
      Cause.fromReasons([Cause.makeFailReason(failure), Cause.makeFailReason(failure)]),
    ],
  ] as const)("returns a cache miss for %s", async (_name, cause) => {
    const provider = { ...TestRuntimeProvider, pullArtifact: () => Effect.failCause(cause) };

    const exit = await Effect.runPromiseExit(producedImagePresent(provider, complete));

    expect(exit).toEqual(Exit.succeed(false));
  });

  test.each([
    ["direct defect", Cause.die(defect), [{ _tag: "Die", defect }]],
    ["direct interrupt", Cause.interrupt(fiberId), [{ _tag: "Interrupt", fiberId }]],
    [
      "typed failure with defect",
      Cause.fromReasons([Cause.makeFailReason(failure), Cause.makeDieReason(defect)]),
      [
        { _tag: "Fail", error: failure },
        { _tag: "Die", defect },
      ],
    ],
    [
      "typed failure with interrupt",
      Cause.fromReasons([Cause.makeFailReason(failure), Cause.makeInterruptReason(fiberId)]),
      [
        { _tag: "Fail", error: failure },
        { _tag: "Interrupt", fiberId },
      ],
    ],
    [
      "typed failure with defect and interrupt",
      Cause.fromReasons([
        Cause.makeFailReason(failure),
        Cause.makeDieReason(defect),
        Cause.makeInterruptReason(fiberId),
      ]),
      [
        { _tag: "Fail", error: failure },
        { _tag: "Die", defect },
        { _tag: "Interrupt", fiberId },
      ],
    ],
  ] as const)("preserves the complete Cause for %s", async (_name, cause, reasons) => {
    const provider = { ...TestRuntimeProvider, pullArtifact: () => Effect.failCause(cause) };

    const exit = await Effect.runPromiseExit(producedImagePresent(provider, complete));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause).toBe(cause);
      expect(exit.cause.reasons).toHaveLength(reasons.length);
      expect(exit.cause.reasons).toMatchObject(reasons);
    }
  });
});
