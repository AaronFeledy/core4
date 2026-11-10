import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { FailureRoleAnnotation } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Context, Effect, Exit, Stream } from "effect";
import { withProviderErrorRedaction } from "../../src/providers/error-policy.ts";
import { plan, target } from "./fixtures/error-registry.ts";

test.each(["effect", "stream", "availability"] as const)(
  "provider %s redaction preserves every reason and its annotations",
  async (mode) => {
    const secret = "provider-cause-annotation-canary";
    const debugCause = { private: secret };
    const error = new ProviderUnavailableError({
      providerId: "test",
      operation: "original",
      message: secret,
      remediation: secret,
      cause: debugCause,
    });
    const defect = new ProviderUnavailableError({
      providerId: "test",
      operation: "defect",
      message: secret,
      remediation: "debug",
    });
    const typedReason = Cause.makeFailReason(error).annotate(Context.make(FailureRoleAnnotation, "rollback"));
    const defectReason = Cause.makeDieReason(defect).annotate(Context.make(FailureRoleAnnotation, "cleanup"));
    const interruptReason = Cause.makeInterruptReason(777);
    const cause = Cause.fromReasons([typedReason, defectReason, interruptReason]);
    const provider = withProviderErrorRedaction(
      {
        ...TestRuntimeProvider,
        isAvailable: Effect.failCause(cause),
        start: () => Effect.failCause(cause),
        exportArtifact: () => Stream.failCause(cause),
      },
      createStandaloneRedactor("secrets", { redactionTokens: [secret] }),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        mode === "availability"
          ? provider.isAvailable
          : mode === "effect"
            ? provider.start(target)
            : provider.exportArtifact({ providerId: plan.provider, ref: "fixture" }).pipe(Stream.runDrain),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected failure");
    expect(exit.cause.reasons).toHaveLength(3);
    const [first, second, third] = exit.cause.reasons;
    if (first === undefined || !Cause.isFailReason(first)) throw new Error("Expected typed reason first");
    expect(first.error).toBeInstanceOf(ProviderUnavailableError);
    expect(first.error).toMatchObject({
      message: "[redacted]",
      remediation: "[redacted]",
      operation: "original",
      cause: debugCause,
    });
    expect(Context.getOrUndefined(Cause.reasonAnnotations(first), FailureRoleAnnotation)).toBe("rollback");
    expect(second).toBe(defectReason);
    expect(third).toBe(interruptReason);
  },
);
