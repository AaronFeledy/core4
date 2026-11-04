import { expect, test } from "bun:test";
import { RedactionService, makeRedactionOwner, makeRedactionService } from "@lando/redaction/service";
import { SecretNotFoundError } from "@lando/sdk/errors";
import { type Environment, encodeUriComponent } from "@lando/sdk/schema";
import { EnvironmentValueResolver, SecretStore, type SecretStoreShape } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { layer } from "../../src/services/environment-value-resolver.ts";

const harness = () => {
  const calls: string[] = [];
  const raw = "canary:@/ ü";
  const store: SecretStoreShape = {
    id: "test",
    get: (reference) =>
      Effect.sync(() => calls.push(reference)).pipe(
        Effect.flatMap(() =>
          reference === "TOKEN"
            ? Effect.succeed(raw)
            : Effect.fail(
                new SecretNotFoundError({
                  message: "Missing secret.",
                  secret: reference,
                  remediation: "Seed this reference.",
                }),
              ),
        ),
      ),
    has: () => Effect.succeed(true),
    list: Effect.die("Observation must never enumerate the store"),
  };
  const redaction = makeRedactionService();
  return {
    calls,
    raw,
    redaction,
    layer: layer.pipe(
      Layer.provide(
        Layer.mergeAll(Layer.succeed(SecretStore, store), Layer.succeed(RedactionService, redaction)),
      ),
    ),
  };
};

test("coalesces concurrent references and registers raw, encoded and composite values before return", async () => {
  // Given
  const h = harness();
  const environment: Environment = {
    RAW: { _tag: "SecretRef", reference: "TOKEN" },
    URI: {
      _tag: "BoundText",
      parts: ["postgres://", { reference: "TOKEN", encoding: "uri-component" }, "/db"],
    },
    LITERAL: "${secret:TOKEN}",
  };
  const redactor = await Effect.runPromise(h.redaction.forProfile("secrets"));
  // When
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* EnvironmentValueResolver).openSession();
        return yield* Effect.all(
          [session.resolveEnvironment(environment), session.resolveEnvironment(environment)],
          { concurrency: "unbounded" },
        );
      }),
    ).pipe(Effect.provide(h.layer)),
  );
  // Then
  expect(h.calls).toEqual(["TOKEN"]);
  expect(result[0]).toEqual({
    RAW: h.raw,
    URI: `postgres://${encodeUriComponent(h.raw)}/db`,
    LITERAL: "${secret:TOKEN}",
  });
  expect(redactor.redactString(`${h.raw} ${encodeUriComponent(h.raw)} ${result[0]?.URI}`)).not.toContain(
    "canary",
  );
});

test("opens a fresh lookup lifetime for each operation", async () => {
  // Given
  const h = harness();
  const operation = Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* EnvironmentValueResolver).openSession();
      return yield* session.resolveEnvironment({ TOKEN: { _tag: "SecretRef", reference: "TOKEN" } });
    }),
  );
  // When
  await Effect.runPromise(Effect.all([operation, operation]).pipe(Effect.provide(h.layer)));
  // Then
  expect(h.calls).toEqual(["TOKEN", "TOKEN"]);
});

test("enforces the byte budget after dynamic resolution without exposing resolved bytes", async () => {
  // Given
  const h = harness();
  // When
  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* EnvironmentValueResolver).openSession();
        return yield* session.resolveEnvironment({
          BIG: { _tag: "BoundText", parts: ["x".repeat(1_048_576), { reference: "TOKEN", encoding: "raw" }] },
        });
      }),
    ).pipe(Effect.flip, Effect.provide(h.layer)),
  );
  // Then
  expect(error._tag).toBe("EnvironmentValueResolutionError");
  expect(JSON.stringify(error)).not.toContain(h.raw);
});

test("fresh operations reread only the requested id while previous masks survive until runtime disposal", async () => {
  // Given
  const owner = makeRedactionOwner();
  const reads: string[] = [];
  const store = SecretStore.of({
    id: "rotating",
    get: (reference) =>
      Effect.sync(() => {
        reads.push(reference);
        return reads.length === 1 ? "operation-one-canary" : "operation-two-canary";
      }),
    has: () => Effect.die("No existence probing"),
    list: Effect.die("No enumeration"),
  });
  const runtime = layer.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(SecretStore, store), Layer.succeed(RedactionService, owner.service)),
    ),
  );
  const retained = await Effect.runPromise(owner.service.forProfile("secrets"));
  const operation = Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* EnvironmentValueResolver).openSession();
      return yield* Effect.all(
        [
          session.resolveEnvironment({ VALUE: { _tag: "SecretRef", reference: "only-this-id" } }),
          session.resolveEnvironment({ VALUE: { _tag: "SecretRef", reference: "only-this-id" } }),
        ],
        { concurrency: "unbounded" },
      );
    }),
  );
  try {
    // When
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* operation;
        const second = yield* operation;
        return [first, second];
      }).pipe(Effect.provide(runtime)),
    );
    // Then
    expect(reads).toEqual(["only-this-id", "only-this-id"]);
    expect(results[0]?.[0]?.VALUE).toBe("operation-one-canary");
    expect(results[1]?.[0]?.VALUE).toBe("operation-two-canary");
    expect(retained.redactString("operation-one-canary operation-two-canary")).toBe("[redacted] [redacted]");
  } finally {
    owner.dispose();
  }
  expect(retained.redactString("operation-one-canary operation-two-canary")).toBe(
    "operation-one-canary operation-two-canary",
  );
});
