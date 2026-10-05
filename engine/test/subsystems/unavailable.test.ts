import { expect, test } from "bun:test";
import { SshError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { unavailableOperation } from "../../src/subsystems/unavailable.ts";

test("unavailableOperation creates a fresh error for each call", async () => {
  const errors: SshError[] = [];
  const operation = unavailableOperation(() => {
    const error = new SshError({ message: "unavailable", sshId: "test" });
    errors.push(error);
    return error;
  });
  const results = await Effect.runPromise(
    Effect.all([operation().pipe(Effect.result), operation().pipe(Effect.result)]),
  );
  expect(errors).toHaveLength(2);
  expect(errors[0]).not.toBe(errors[1]);
  expect([...results]).toEqual(errors.map(Result.fail));
});

test("unavailableOperation forwards typed call arguments to the factory", async () => {
  const operation = unavailableOperation(
    (id: string, attempt: number) => new SshError({ message: `attempt ${attempt}`, sshId: id }),
  );
  const result = await Effect.runPromise(operation("requested", 3).pipe(Effect.result));
  expect(result).toEqual(Result.fail(new SshError({ message: "attempt 3", sshId: "requested" })));
});
