import { describe, expect, test } from "bun:test";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { identityRedactor } from "@lando/sdk/command-result";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import {
  type CliInvocationSnapshot,
  makeNestedCommandInvocation,
  runCommandLifecycle,
} from "../../src/cli/command-lifecycle.ts";

const input = { argv: [], args: {}, flags: {} };
const nested = () => makeNestedCommandInvocation("meta:version", input);
const invocation = (id: string): CliInvocationSnapshot => ({
  ...input,
  commandId: "meta:version",
  cwd: `/invocations/${id}`,
  invocationId: id,
});
const redaction = Layer.succeed(RedactionService, {
  registerValues: registerRedactionValues,
  forProfile: () => Effect.succeed(identityRedactor),
});
const lifecycle = <A, E, R>(work: Effect.Effect<A, E, R>, parent: CliInvocationSnapshot) =>
  Effect.gen(function* () {
    const exit = yield* runCommandLifecycle(work, { invocation: parent });
    return yield* exit;
  });

describe("command invocation fiber-local ancestry", () => {
  test("has no parent outside a lifecycle and uses the ambient or explicit cwd", async () => {
    // Given
    const cwd = process.cwd();
    // When
    const [ambient, explicit] = await Effect.runPromise(
      Effect.all([nested(), makeNestedCommandInvocation("meta:version", { ...input, cwd: "/explicit" })]),
    );
    // Then
    expect(ambient.parentInvocationId).toBeUndefined();
    expect(ambient.cwd).toBe(cwd);
    expect(explicit.parentInvocationId).toBeUndefined();
    expect(explicit.cwd).toBe("/explicit");
    expect(ambient.invocationId).toBeTruthy();
    expect(explicit.invocationId).not.toBe(ambient.invocationId);
  });

  test("restores the outer ancestry after a nested invocation and the default after exit", async () => {
    // Given
    const outer = invocation("outer");
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bound = yield* lifecycle(
          Effect.gen(function* () {
            const child = yield* nested();
            const grandchild = yield* lifecycle(nested(), child);
            const restored = yield* nested();
            const explicit = yield* makeNestedCommandInvocation("meta:version", {
              ...input,
              cwd: "/override",
            });
            return { child, grandchild, restored, explicit };
          }),
          outer,
        );
        return { ...bound, after: yield* nested() };
      }).pipe(Effect.provide(redaction)),
    );
    // Then
    expect(result.child.parentInvocationId).toBe("outer");
    expect(result.child.cwd).toBe(outer.cwd);
    expect(result.grandchild.parentInvocationId).toBe(result.child.invocationId);
    expect(result.grandchild.invocationId).not.toBe(result.child.invocationId);
    expect(result.restored.parentInvocationId).toBe("outer");
    expect(result.explicit).toMatchObject({ parentInvocationId: "outer", cwd: "/override" });
    expect(result.after.parentInvocationId).toBeUndefined();
    expect(result.after.cwd).toBe(process.cwd());
  });

  test("forked children inherit an automatically generated invocation id", async () => {
    // Given
    const parent = { ...input, commandId: "meta:version", cwd: "/generated" };
    // When
    const result = await Effect.runPromise(
      lifecycle(
        Effect.gen(function* () {
          const direct = yield* nested();
          const child = yield* Effect.fork(nested());
          return { direct, child: yield* Fiber.join(child) };
        }),
        parent,
      ).pipe(Effect.provide(redaction)),
    );
    // Then
    expect(result.direct.parentInvocationId).toBeTruthy();
    expect(result.child.parentInvocationId).toBe(result.direct.parentInvocationId);
    expect(result.child.invocationId).not.toBe(result.direct.invocationId);
    expect(result.child.cwd).toBe("/generated");
  });

  test("overlapping sibling lifecycles retain separate ids and cwd snapshots", async () => {
    // Given / When
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const left = yield* Deferred.make<void>();
        const right = yield* Deferred.make<void>();
        return yield* Effect.all(
          [
            lifecycle(
              Deferred.succeed(left, undefined).pipe(
                Effect.zipRight(Deferred.await(right)),
                Effect.zipRight(nested()),
              ),
              invocation("left"),
            ),
            lifecycle(
              Deferred.succeed(right, undefined).pipe(
                Effect.zipRight(Deferred.await(left)),
                Effect.zipRight(nested()),
              ),
              invocation("right"),
            ),
          ],
          { concurrency: 2 },
        );
      }).pipe(Effect.provide(redaction)),
    );
    // Then
    expect(results.map(({ parentInvocationId, cwd }) => ({ parentInvocationId, cwd }))).toEqual([
      { parentInvocationId: "left", cwd: "/invocations/left" },
      { parentInvocationId: "right", cwd: "/invocations/right" },
    ]);
  });

  test("clears the invocation binding when the command fails", async () => {
    // Given / When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* runCommandLifecycle(Effect.fail("command-failed"), {
          invocation: invocation("failed"),
        });
        return { exit, after: yield* nested() };
      }).pipe(Effect.provide(redaction)),
    );
    // Then
    expect(result.exit).toEqual(Exit.fail("command-failed"));
    expect(result.after.parentInvocationId).toBeUndefined();
  });
});
