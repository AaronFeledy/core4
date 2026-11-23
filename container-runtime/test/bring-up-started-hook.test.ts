import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { ctx, fakeEngine, plan, service, withService } from "./fixtures/environment-values.ts";
import { bringUp } from "./support/service-creation.ts";

test("hands each started container's id to the provider before apply returns", async () => {
  // Given a service whose container is created and started by apply
  const engine = fakeEngine(undefined, false);
  const started: string[] = [];
  // When
  await Effect.runPromise(
    bringUp(withService(service), {
      api: engine.api,
      ctx,
      onContainerStarted: (id) => Effect.sync(() => started.push(id)),
    }),
  );
  // Then the hook saw the running container once, by id
  expect(started).toEqual(["owned-id"]);
});

test("a failing started hook fails apply", async () => {
  // Given a provider hook that cannot attach its per-container work
  const engine = fakeEngine(plan, true);
  const failure = new ProviderUnavailableError({
    providerId: "docker",
    operation: "nativeHealth",
    message: "Could not schedule.",
    remediation: "Retry.",
  });
  // When / Then
  const error = await Effect.runPromise(
    Effect.flip(
      bringUp(withService(service), { api: engine.api, ctx, onContainerStarted: () => Effect.fail(failure) }),
    ),
  );
  expect(error).toBe(failure);
});
