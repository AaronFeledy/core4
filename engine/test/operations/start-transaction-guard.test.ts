import { expect, test } from "bun:test";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { ManagedFileTransactionGuard, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Either } from "effect";
import { startAppForTarget } from "../../src/operations/start.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("fails start before provider selection or events when the transaction is blocked", async () => {
  // Given
  const harness = makeHarness();
  const roots: string[] = [];
  const failure = new ManagedFileTransactionError({
    reason: "blocked",
    phase: "recover",
    path: String(plan.root),
    cause: "invariant",
    remediation: "Resolve the conflicting target before starting.",
  });

  // When
  const result = await Effect.runPromise(
    startAppForTarget(undefined, {
      plan,
      root: plan.root,
      app: { kind: "user", id: plan.id, root: plan.root },
    }).pipe(
      Effect.provideService(ManagedFileTransactionGuard, {
        ensureConsistent: (root) => {
          roots.push(root);
          return Effect.fail(failure);
        },
        pending: () => Effect.succeed(null),
      }),
      Effect.provideService(RuntimeProviderRegistry, {
        list: Effect.die("Provider registry must not run"),
        capabilities: Effect.die("Provider capabilities must not run"),
        select: () => Effect.die("Provider selection must not run"),
      }),
      Effect.provide(harness.layer),
      Effect.either,
    ),
  );

  // Then
  expect(Either.isLeft(result) && result.left).toBe(failure);
  expect(roots).toEqual([String(plan.root)]);
  expect(harness.events).toEqual([]);
});
