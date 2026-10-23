import { afterEach, expect, test } from "bun:test";
import {
  makeRedactionService,
  registerRedactionValues,
  resetRegisteredRedactionValuesForTesting,
} from "@lando/redaction/service";
import {
  type AppResolveError,
  type NoProviderInstalledError,
  ProviderCapabilityError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, type Context, Effect, Exit, Result, Stream } from "effect";
import { assertRedactedError } from "./fixtures/assert-redacted-error.ts";
import { canary, errorFields, plan, registryLayer, target } from "./fixtures/error-registry.ts";

afterEach(resetRegisteredRedactionValuesForTesting);
type Registry = Context.Service.Shape<typeof RuntimeProviderRegistry>;
type RegistryCall = (
  registry: Registry,
) => Effect.Effect<unknown, ProviderError | AppResolveError | NoProviderInstalledError>;
const evidenceCalls = {
  resolveAppliedPlan: (r) => r.resolveAppliedPlan?.(plan.root) ?? Effect.die("missing resolveAppliedPlan"),
  resolveTeardownEvidence: (r) =>
    r.resolveTeardownEvidence?.(plan.root) ?? Effect.die("missing resolveTeardownEvidence"),
  observeRuntime: (r) => r.observeRuntime ?? Effect.die("missing observeRuntime"),
  outputRegistration: (r) =>
    r.select(plan).pipe(Effect.flatMap((p) => p.exec(target, { command: ["false"] }))),
} satisfies Readonly<Record<string, RegistryCall>>;

test.each(Object.entries(evidenceCalls))(
  "contribution appliedPlans is redacted through %s",
  async (_member, invoke: RegistryCall) => {
    // Given
    const original = new ProviderUnavailableError(errorFields);
    const layer = registryLayer(TestRuntimeProvider, {
      contribution: { appliedPlans: () => Effect.fail(original) },
    });
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerRedactionValues([canary]);
        return yield* Effect.result(invoke(yield* RuntimeProviderRegistry));
      }).pipe(Effect.provide(layer)),
    );
    // Then
    if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
      throw new Error("Expected provider failure");
    await assertRedactedError(result.failure, original);
  },
);

const ownershipCalls = {
  direct: (r) => r.resourceOwnership?.(plan.provider, plan.root) ?? Effect.die("missing resourceOwnership"),
  resolveAppliedPlan: evidenceCalls.resolveAppliedPlan,
  resolveTeardownEvidence: evidenceCalls.resolveTeardownEvidence,
} satisfies Readonly<Record<string, RegistryCall>>;
test.each(Object.entries(ownershipCalls))(
  "contribution resourceOwnership is redacted through %s",
  async (_member, invoke: RegistryCall) => {
    // Given
    const original = new ProviderUnavailableError(errorFields);
    const layer = registryLayer(TestRuntimeProvider, {
      contribution: {
        appliedPlans: () => Effect.succeed([]),
        resourceOwnership: () => Effect.fail(original),
      },
    });
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerRedactionValues([canary]);
        return yield* Effect.result(invoke(yield* RuntimeProviderRegistry));
      }).pipe(Effect.provide(layer)),
    );
    // Then
    if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
      throw new Error("Expected provider failure");
    await assertRedactedError(result.failure, original);
  },
);

test("provider construction failures are reconstructed before being returned", async () => {
  // Given
  const original = new ProviderUnavailableError(errorFields);
  const layer = registryLayer(TestRuntimeProvider, { contribution: { make: () => Effect.fail(original) } });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* registerRedactionValues([canary]);
      return yield* Effect.result((yield* RuntimeProviderRegistry).select(plan));
    }).pipe(Effect.provide(layer)),
  );
  // Then
  if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
    throw new Error("Expected construction failure");
  await assertRedactedError(result.failure, original);
});

test("capability construction failures retain their original debug cause after conversion", async () => {
  // Given
  const original = new ProviderCapabilityError({
    ...errorFields,
    capability: "test",
    requiredValue: true,
    actualValue: false,
  });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* registerRedactionValues([canary]);
      return yield* Effect.result((yield* RuntimeProviderRegistry).select(plan));
    }).pipe(
      Effect.provide(
        registryLayer(TestRuntimeProvider, { contribution: { make: () => Effect.fail(original) } }),
      ),
    ),
  );
  // Then
  if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
    throw new Error("Expected construction failure");
  expect(result.failure.message).toBe("failed [redacted]");
  expect(JSON.stringify(result.failure.details)).not.toContain(canary);
  expect(result.failure.remediation).toBe("retry [redacted]");
  expect(result.failure.cause).toBe(original);
});

test.each(["effect", "stream"] as const)("%s defects are not sanitized", async (kind) => {
  // Given
  const defect = new ProviderUnavailableError(errorFields);
  const provider = {
    ...TestRuntimeProvider,
    start: () => Effect.die(defect),
    exportArtifact: () => Stream.die(defect),
  };
  // When
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerRedactionValues([canary]);
        const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
        return yield* Effect.exit(
          kind === "effect"
            ? selected.start(target)
            : Stream.runDrain(selected.exportArtifact({ providerId: plan.provider, ref: "image" })),
        );
      }),
    ).pipe(Effect.provide(registryLayer(provider))),
  );
  // Then
  if (Exit.isSuccess(exit)) throw new Error("Expected defect");
  const found = Cause.findDie(exit.cause);
  expect(Result.isFailure(found) ? undefined : found.success.defect).toBe(defect);
  expect(defect.message).toContain(canary);
});

test("interruption remains interruption", async () => {
  // Given
  const provider = { ...TestRuntimeProvider, start: () => Effect.interrupt };
  // When
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
      return yield* Effect.exit(selected.start(target));
    }).pipe(Effect.provide(registryLayer(provider))),
  );
  // Then
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
});

test("the original cause is debug-only and untouched", async () => {
  // Given
  const cause = { raw: canary };
  const original = new ProviderUnavailableError({ ...errorFields, cause });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* registerRedactionValues([canary]);
      const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
      return yield* Effect.result(selected.start(target));
    }).pipe(Effect.provide(registryLayer({ ...TestRuntimeProvider, start: () => Effect.fail(original) }))),
  );
  // Then
  if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
    throw new Error("Expected provider failure");
  expect(result.failure.cause).toBe(cause);
  expect(result.failure.message).toBe("failed [redacted]");
});

test.each(["live", "standalone"] as const)(
  "%s redactors mask values registered after provider selection",
  async (mode) => {
    // Given
    const original = new ProviderUnavailableError(errorFields);
    const provider = { ...TestRuntimeProvider, start: () => Effect.fail(original) };
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
        yield* registerRedactionValues([canary]);
        return yield* Effect.result(selected.start(target));
      }).pipe(Effect.provide(registryLayer(provider, mode === "standalone" ? { redaction: null } : {}))),
    );
    // Then
    if (Result.isSuccess(result)) throw new Error("Expected provider failure");
    await assertRedactedError(result.failure, original);
  },
);

test("the live redactor includes store-only values", async () => {
  // Given
  const original = new ProviderUnavailableError(errorFields);
  const redaction = makeRedactionService({
    id: "store",
    list: Effect.succeed(["canary"]),
    get: () => Effect.succeed(canary),
    has: () => Effect.succeed(true),
  });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
      return yield* Effect.result(selected.start(target));
    }).pipe(
      Effect.provide(
        registryLayer({ ...TestRuntimeProvider, start: () => Effect.fail(original) }, { redaction }),
      ),
    ),
  );
  // Then
  if (Result.isSuccess(result)) throw new Error("Expected provider failure");
  await assertRedactedError(result.failure, original);
});
