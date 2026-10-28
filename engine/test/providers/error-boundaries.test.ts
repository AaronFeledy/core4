import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  type AppResolveError,
  type NoProviderInstalledError,
  ProviderCapabilityError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Result, Schema, Stream } from "effect";
import { assertRedactedError } from "./fixtures/assert-redacted-error.ts";
import { canary, errorFields, plan, registryLayer, target } from "./fixtures/error-registry.ts";

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
        yield* (yield* RedactionService).registerValues([canary]);
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
        yield* (yield* RedactionService).registerValues([canary]);
        return yield* Effect.result(invoke(yield* RuntimeProviderRegistry));
      }).pipe(Effect.provide(layer)),
    );
    // Then
    if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
      throw new Error("Expected provider failure");
    await assertRedactedError(result.failure, original);
  },
);

const contributionCalls = {
  appliedPlans: (r: Registry) => r.appliedPlansFor(plan.root),
  appliedStateInventory: (r: Registry) =>
    r.assertAppliedStateReadable?.(plan) ?? Effect.die("missing inventory check"),
  resourceOwnership: (r: Registry) =>
    r.resourceOwnership?.(plan.provider, plan.root) ?? Effect.die("missing resourceOwnership"),
} satisfies Readonly<Record<string, RegistryCall>>;

test.each(Object.entries(contributionCalls))(
  "contribution %s preserves every annotated failure reason without initializing a runtime",
  async (member, invoke: RegistryCall) => {
    const annotation = Context.Reference(`test/contribution-${member}`, {
      defaultValue: () => "missing",
    });
    const detailError = new Error(`detail ${canary}`);
    detailError.name = `name ${canary}`;
    const first = new ProviderUnavailableError({
      ...errorFields,
      details: { [canary]: { [`key-${canary}`]: canary }, error: detailError },
      cause: { debug: "original" },
    });
    const second = new ProviderUnavailableError({
      ...errorFields,
      operation: "secondary",
      details: { nested: [canary] },
    });
    const defect = new Error("defect remains a defect");
    const cause = Cause.combine(
      Cause.annotate(Cause.fail(first), Context.make(annotation, "first")),
      Cause.combine(
        Cause.annotate(Cause.fail(second), Context.make(annotation, "second")),
        Cause.combine(
          Cause.annotate(Cause.die(defect), Context.make(annotation, "defect")),
          Cause.annotate(Cause.interrupt(7), Context.make(annotation, "interrupt")),
        ),
      ),
    );
    let runtimeInitializations = 0;
    const failure = Effect.failCause(cause);
    const layer = registryLayer(TestRuntimeProvider, {
      contribution: {
        appliedPlans: () => failure,
        appliedStateInventory: () => failure,
        resourceOwnership: () => failure,
        make: () =>
          Effect.sync(() => {
            runtimeInitializations += 1;
            return TestRuntimeProvider;
          }),
      },
    });

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* RedactionService).registerValues([canary]);
        return yield* Effect.exit(invoke(yield* RuntimeProviderRegistry));
      }).pipe(Effect.provide(layer)),
    );

    expect(runtimeInitializations).toBe(0);
    if (Exit.isSuccess(exit)) throw new Error("Expected callback failure");
    expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail", "Fail", "Die", "Interrupt"]);
    expect(
      exit.cause.reasons.map((reason) => Context.get(Cause.reasonAnnotations(reason), annotation)),
    ).toEqual(["first", "second", "defect", "interrupt"]);
    const failures = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
    expect(failures).toHaveLength(2);
    for (const [index, error] of failures.entries()) {
      if (!(error instanceof ProviderUnavailableError)) throw new Error("Expected typed provider failure");
      expect(error._tag).toBe("ProviderUnavailableError");
      expect(error.operation).toBe(index === 0 ? first.operation : second.operation);
      expect(error.message).toBe("failed [redacted]");
      expect(error.remediation).toBe("retry [redacted]");
      expect(JSON.stringify(error.details)).not.toContain(canary);
      expect(Schema.encodeUnknownSync(ProviderUnavailableError)(error)).toMatchObject({
        _tag: "ProviderUnavailableError",
      });
      const yielded = await Effect.runPromise(Effect.result(error));
      expect(Result.isFailure(yielded) ? yielded.failure : undefined).toBe(error);
    }
    const primary = failures[0];
    if (!(primary instanceof ProviderUnavailableError)) throw new Error("Expected primary provider failure");
    expect(primary.cause).toBe(first.cause);
    expect(primary.details).toEqual({
      error: { name: "name [redacted]", message: "detail [redacted]" },
    });
    expect(failures[1]).toMatchObject({ details: { nested: ["[redacted]"] } });
    expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(defect);
    expect(exit.cause.reasons.find(Cause.isInterruptReason)?.fiberId).toBe(7);
  },
);

test.each(Object.entries(contributionCalls))(
  "contribution %s propagates real interruption and runs its finalizer",
  async (_member, invoke: RegistryCall) => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    let finalizers = 0;
    let runtimeInitializations = 0;
    const pending = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          finalizers += 1;
        }),
      ),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(invoke(yield* RuntimeProviderRegistry));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }).pipe(
        Effect.provide(
          registryLayer(TestRuntimeProvider, {
            contribution: {
              appliedPlans: () => pending,
              appliedStateInventory: () => pending,
              resourceOwnership: () => pending,
              make: () =>
                Effect.sync(() => {
                  runtimeInitializations += 1;
                  return TestRuntimeProvider;
                }),
            },
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(finalizers).toBe(1);
    expect(runtimeInitializations).toBe(0);
  },
);

test.each(["resolveAppliedPlan", "resolveTeardownEvidence"] as const)(
  "contribution appliedStateInventory is redacted through %s evidence",
  async (member) => {
    const invoke: RegistryCall = (registry) =>
      member === "resolveAppliedPlan"
        ? registry.resolveAppliedPlan(plan.root)
        : registry.resolveTeardownEvidence(plan.root);
    const original = new ProviderUnavailableError(errorFields);
    const layer = registryLayer(TestRuntimeProvider, {
      contribution: {
        appliedPlans: () => Effect.die("must use inventory"),
        appliedStateInventory: () => Effect.fail(original),
        make: () => Effect.die("must not initialize runtime"),
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* RedactionService).registerValues([canary]);
        return yield* Effect.result(invoke(yield* RuntimeProviderRegistry));
      }).pipe(Effect.provide(layer)),
    );
    if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
      throw new Error("Expected inventory failure");
    await assertRedactedError(result.failure, original);
  },
);

test("contribution diagnostics fail closed when a detail value cannot be inspected", async () => {
  const hostile: unknown[] = [];
  Object.defineProperty(hostile, "0", {
    enumerable: true,
    get: () => {
      throw new Error(canary);
    },
  });
  hostile.length = 1;
  const original = new ProviderUnavailableError({ ...errorFields, details: hostile });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* RedactionService).registerValues([canary]);
      return yield* Effect.result((yield* RuntimeProviderRegistry).appliedPlansFor(plan.root));
    }).pipe(
      Effect.provide(
        registryLayer(TestRuntimeProvider, {
          contribution: {
            appliedPlans: () => Effect.fail(original),
            make: () => Effect.die("must not initialize runtime"),
          },
        }),
      ),
    ),
  );
  if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
    throw new Error("Expected provider failure");
  expect(result.failure.details).toEqual(["[redacted]"]);
  expect(result.failure.message).toBe("failed [redacted]");
  expect(result.failure.remediation).toBe("retry [redacted]");
});

test("contribution diagnostics suppress callable serialization hooks", async () => {
  const original = new ProviderUnavailableError({
    ...errorFields,
    details: { toJSON: () => canary, nested: [canary] },
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* RedactionService).registerValues([canary]);
      return yield* Effect.result((yield* RuntimeProviderRegistry).appliedPlansFor(plan.root));
    }).pipe(
      Effect.provide(
        registryLayer(TestRuntimeProvider, {
          contribution: {
            appliedPlans: () => Effect.fail(original),
            make: () => Effect.die("must not initialize runtime"),
          },
        }),
      ),
    ),
  );
  if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
    throw new Error("Expected provider failure");
  expect(result.failure.details).toEqual({ nested: ["[redacted]"] });
  expect(JSON.stringify(result.failure)).not.toContain(canary);
});

test("contribution diagnostics safely project adversarial structures", async () => {
  let toJSONCalls = 0;
  let accessorCalls = 0;
  let proxyCalls = 0;
  class HostileArray extends Array<unknown> {
    toJSON() {
      toJSONCalls += 1;
      return canary;
    }
  }
  const subclass = new HostileArray();
  subclass.push(canary);
  const accessor: Record<string, unknown> = { safe: "visible" };
  Object.defineProperty(accessor, "danger", {
    enumerable: true,
    get: () => {
      accessorCalls += 1;
      return canary;
    },
  });
  const proxy = new Proxy(
    { value: canary },
    {
      ownKeys: (target) => {
        proxyCalls += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  const shared = { value: canary };
  const cases: ReadonlyArray<{ name: string; details: unknown; expected: unknown }> = [
    { name: "array subclass", details: subclass, expected: ["[redacted]"] },
    { name: "accessor", details: accessor, expected: { safe: "visible", danger: "[redacted]" } },
    { name: "proxy", details: proxy, expected: "[redacted]" },
    {
      name: "shared alias",
      details: { left: shared, right: shared },
      expected: { left: { value: "[redacted]" }, right: { value: "[redacted]" } },
    },
    {
      name: "redacted-key collision",
      details: { [`key-${canary}`]: "hidden", "key-[redacted]": "visible" },
      expected: { "key-[redacted]": "visible" },
    },
  ];
  for (const item of cases) {
    const original = new ProviderUnavailableError({ ...errorFields, details: item.details });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* RedactionService).registerValues([canary]);
        return yield* Effect.result((yield* RuntimeProviderRegistry).appliedPlansFor(plan.root));
      }).pipe(
        Effect.provide(
          registryLayer(TestRuntimeProvider, {
            contribution: {
              appliedPlans: () => Effect.fail(original),
              make: () => Effect.die("must not initialize runtime"),
            },
          }),
        ),
      ),
    );
    if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
      throw new Error(`Expected provider failure for ${item.name}`);
    expect(result.failure.details).toEqual(item.expected);
    expect(JSON.stringify(result.failure)).not.toContain(canary);
  }
  expect([toJSONCalls, accessorCalls, proxyCalls]).toEqual([0, 0, 0]);
});

test("an unreadable local inventory stays an actionable applied-state failure", async () => {
  const path = "/tmp/error-boundary/unreadable-state.json";
  let runtimeInitializations = 0;
  const layer = registryLayer(TestRuntimeProvider, {
    contribution: {
      appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [{ path }] }),
      make: () =>
        Effect.sync(() => {
          runtimeInitializations += 1;
          return TestRuntimeProvider;
        }),
    },
  });
  const result = await Effect.runPromise(
    Effect.flatMap(RuntimeProviderRegistry, (registry) =>
      Effect.result(registry.assertAppliedStateReadable?.(plan) ?? Effect.die("missing inventory check")),
    ).pipe(Effect.provide(layer)),
  );
  expect(runtimeInitializations).toBe(0);
  if (Result.isSuccess(result)) throw new Error("Expected unreadable state failure");
  expect(result.failure).toMatchObject({
    _tag: "ProviderUnavailableError",
    providerId: plan.provider,
    operation: "applied-state.read",
  });
  expect(result.failure.message).toContain(path);
  expect(result.failure.remediation).toContain(path);
});

test("an unreadable inventory path is redacted without losing remediation", async () => {
  const path = `/tmp/${canary}/unreadable-state.json`;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* RedactionService).registerValues([canary]);
      return yield* Effect.result(
        (yield* RuntimeProviderRegistry).assertAppliedStateReadable?.(plan) ??
          Effect.die("missing inventory check"),
      );
    }).pipe(
      Effect.provide(
        registryLayer(TestRuntimeProvider, {
          contribution: {
            appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [{ path }] }),
            make: () => Effect.die("must not initialize runtime"),
          },
        }),
      ),
    ),
  );
  if (Result.isSuccess(result) || !(result.failure instanceof ProviderUnavailableError))
    throw new Error("Expected unreadable state failure");
  expect(result.failure.operation).toBe("applied-state.read");
  expect(result.failure.message).toContain("[redacted]");
  expect(result.failure.message).not.toContain(canary);
  expect(result.failure.remediation).toContain("Restore");
  expect(result.failure.remediation).toContain("[redacted]");
  expect(result.failure.remediation).not.toContain(canary);
});

test("provider construction failures are reconstructed before being returned", async () => {
  // Given
  const original = new ProviderUnavailableError(errorFields);
  const layer = registryLayer(TestRuntimeProvider, { contribution: { make: () => Effect.fail(original) } });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* RedactionService).registerValues([canary]);
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
      yield* (yield* RedactionService).registerValues([canary]);
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
        yield* (yield* RedactionService).registerValues([canary]);
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
      yield* (yield* RedactionService).registerValues([canary]);
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

test.each(["live", "retained"] as const)(
  "%s redactors mask values registered after provider selection",
  async (mode) => {
    // Given
    const original = new ProviderUnavailableError(errorFields);
    const provider = { ...TestRuntimeProvider, start: () => Effect.fail(original) };
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const selected = yield* (yield* RuntimeProviderRegistry).select(plan);
        yield* (yield* RedactionService).registerValues([canary]);
        return yield* Effect.result(selected.start(target));
      }).pipe(
        Effect.provide(
          registryLayer(provider, mode === "retained" ? { redaction: makeRedactionService() } : {}),
        ),
      ),
    );
    // Then
    if (Result.isSuccess(result)) throw new Error("Expected provider failure");
    await assertRedactedError(result.failure, original);
  },
);

test("the live redactor includes explicitly registered resolved values", async () => {
  // Given
  const original = new ProviderUnavailableError(errorFields);
  const redaction = makeRedactionService();
  await Effect.runPromise(redaction.registerValues([canary]));
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
