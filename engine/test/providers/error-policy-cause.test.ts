import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { FailureRoleAnnotation, failureOutcomeFromCause } from "@lando/sdk/command-result";
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
    if (second === undefined || !Cause.isDieReason(second)) throw new Error("Expected the defect second");
    expect(second.defect).toBeInstanceOf(ProviderUnavailableError);
    expect(second.defect).toMatchObject({ message: "[redacted]", remediation: "debug", operation: "defect" });
    expect(Context.getOrUndefined(Cause.reasonAnnotations(second), FailureRoleAnnotation)).toBe("cleanup");
    expect(third).toBe(interruptReason);
  },
);

test("a provider failure Effect carries as a defect after its cleanup died is still redacted", async () => {
  // Given a provider whose typed failure is elected into a defect because its own finalizer died.
  const secret = "elected-provider-canary";
  const error = new ProviderUnavailableError({
    providerId: "test",
    operation: "start",
    message: secret,
    remediation: "Retry.",
  });
  const provider = withProviderErrorRedaction(
    {
      ...TestRuntimeProvider,
      start: () => Effect.fail(error).pipe(Effect.ensuring(Effect.die(new Error("release crashed")))),
    },
    createStandaloneRedactor("secrets", { redactionTokens: [secret] }),
  );
  const exit = await Effect.runPromiseExit(provider.start(target));
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  // Then the secret never leaves the registry, and the failure still projects as the typed primary.
  expect(
    JSON.stringify(exit.cause.reasons.map((reason) => (Cause.isDieReason(reason) ? reason.defect : reason))),
  ).not.toContain(secret);
  expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
    kind: "typed",
    source: "elected",
    error: { _tag: "ProviderUnavailableError", message: "[redacted]", operation: "start" },
  });
});

test("native restore forwards the caller's pre-publication check and keeps its failure unredacted", async () => {
  const secret = "restore-before-commit-canary";
  let forwarded: unknown;
  const provider = withProviderErrorRedaction(
    {
      ...TestRuntimeProvider,
      restoreVolume: (_spec, options) => {
        forwarded = options?.beforeCommit;
        return options?.beforeCommit ?? Effect.void;
      },
    },
    createStandaloneRedactor("secrets", { redactionTokens: [secret] }),
  );
  const beforeCommit = Effect.fail(secret);

  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      provider.restoreVolume(
        {
          snapshot: {
            provider: plan.provider,
            id: "snap",
            digest: "sha256:snap",
            sizeBytes: 1,
            format: "native",
          },
          target: { app: target.app, store: "data" },
          expectedTargetGeneration: "00000000-0000-4000-8000-000000000001",
        },
        { beforeCommit },
      ),
    ),
  );

  expect(forwarded).toBe(beforeCommit);
  expect(exit).toStrictEqual(Exit.fail(secret));
});
