import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import { EventError, LandofileValidationError, ScratchAppError } from "@lando/sdk/errors";
import { ScratchAppService } from "@lando/sdk/services";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { withStartupFixture } from "./startup-fixture.ts";

const acquire = (keepOnFailure = false) =>
  Effect.flatMap(ScratchAppService, (scratch) =>
    scratch.acquire({ source: { kind: "fork" }, isolate: "none", detached: false, keepOnFailure }),
  );

const planningFailure = new LandofileValidationError({
  file: ".lando.yml",
  message: "Invalid route plan",
  remediation: "Correct the route configuration.",
  issues: [],
});

test("interruption during scratch planning reaps the registered instance", async () => {
  const planning = Deferred.makeUnsafe<void>();
  await withStartupFixture(
    {},
    async ({ layer, entries, root }) => {
      const fiber = Effect.runFork(acquire().pipe(Effect.scoped, Effect.provide(layer)));
      const id = await Effect.runPromise(Deferred.await(planning)).then(() => entries.keys().next().value);
      const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      if (id === undefined) throw new TypeError("Planning should begin after registration");
      expect(entries.has(id)).toBe(false);
      expect(existsSync(join(root, "scratch", id))).toBe(false);
    },
    { planScratch: Deferred.succeed(planning, undefined).pipe(Effect.andThen(Effect.never)) },
  );
});

test("early cleanup failure is an additional error, not the primary planning error", async () => {
  const cleanupFailure = new EventError({
    event: "pre-scratch-destroy",
    message: "Subscriber rejected removal",
    remediation: "Repair the scratch destroy subscriber.",
  });
  await withStartupFixture(
    {},
    async ({ layer, entries, root }) => {
      const exit = await Effect.runPromiseExit(acquire().pipe(Effect.scoped, Effect.provide(layer)));
      const id = entries.keys().next().value;
      if (id === undefined) throw new TypeError("Expected the unreaped registration");
      const outcome = Exit.isFailure(exit) ? failureOutcomeFromCause(exit.cause) : undefined;
      expect(outcome).toMatchObject({
        error: { _tag: "ScratchAppError", operation: "start", cause: planningFailure },
        additionalErrors: [
          {
            role: "cleanup",
            error: {
              _tag: "ScratchAppError",
              operation: "cleanup",
              scratchId: id,
              remediation: expect.stringContaining(`lando scratch:destroy ${id}`),
            },
          },
        ],
      });
      if (!(outcome?.error instanceof ScratchAppError)) throw new TypeError("Expected ScratchAppError");
      expect(outcome.error.scratchId).toBeUndefined();
      expect(existsSync(join(root, "scratch", id))).toBe(true);
    },
    { planScratch: Effect.fail(planningFailure), eventFailure: cleanupFailure },
  );
});

test("keep-on-failure puts the scratch id on the primary error and skips reap", async () => {
  await withStartupFixture(
    {},
    async ({ layer, entries, root }) => {
      const exit = await Effect.runPromiseExit(acquire(true).pipe(Effect.scoped, Effect.provide(layer)));
      const id = entries.keys().next().value;
      if (id === undefined) throw new TypeError("Expected the retained registration");
      expect(Exit.isFailure(exit) ? failureOutcomeFromCause(exit.cause) : undefined).toMatchObject({
        error: { _tag: "ScratchAppError", operation: "start", scratchId: id, cause: planningFailure },
        additionalErrors: [],
      });
      expect(existsSync(join(root, "scratch", id))).toBe(true);
    },
    { planScratch: Effect.fail(planningFailure) },
  );
});

test("scope-close event failure warns with the scratch id after successful removal", async () => {
  await withStartupFixture(
    { exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }) },
    async ({ layer, entries, events, root }) => {
      const handle = await Effect.runPromise(acquire().pipe(Effect.scoped, Effect.provide(layer)));
      expect(events.filter((event) => event._tag === "message.warn")).toContainEqual(
        expect.objectContaining({ body: expect.stringContaining(`lando scratch:destroy ${handle.id}`) }),
      );
      expect(entries.has(handle.id)).toBe(false);
      expect(existsSync(join(root, "scratch", handle.id))).toBe(false);
    },
    {
      eventFailure: new EventError({
        event: "post-scratch-destroy",
        message: "Subscriber rejected the removal notification",
        remediation: "Repair the scratch destroy subscriber.",
      }),
    },
  );
});
