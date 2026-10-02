import { expect, test } from "bun:test";
import { ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import { EventService, ProcessRunner, type ProcessSpawnOptions, SecretStore } from "@lando/sdk/services";
import { Deferred, Effect, Either, Fiber, Option, Stream } from "effect";
import type { OpRunner } from "../src/op-cli.ts";

const reference = "op://Vault/Item With Space/field?ssh-format=openssh";
const output = { exitCode: 0, stdout: " sentinel-sensitive-output\n", stderr: "", timedOut: false };

test("resolves op://Vault/Item/field through op read --no-newline", async () => {
  // Given
  const { makeOnePasswordSecretStore } = await import("../src/store.ts");
  const calls: { readonly args: readonly string[]; readonly timeoutMs: number }[] = [];
  const run: OpRunner = (args, options) =>
    Effect.sync(() => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      return output;
    });
  // When
  const value = await Effect.runPromise(makeOnePasswordSecretStore({ run }).get(reference));
  // Then
  expect(value).toBe(output.stdout);
  expect(calls).toEqual([{ args: ["read", "--no-newline", reference], timeoutMs: 120_000 }]);
});

test.each([
  { stderr: "not signed in: sensitive-stderr", timedOut: false, reason: "unauthenticated" },
  { stderr: "account locked: sensitive-stderr", timedOut: false, reason: "locked" },
  { stderr: "permission denied: sensitive-stderr", timedOut: false, reason: "denied" },
  { stderr: "sensitive-stderr", timedOut: true, reason: "timeout" },
])("get and has fail $reason without echoing process output", async ({ stderr, timedOut, reason }) => {
  // Given
  const { makeOnePasswordSecretStore } = await import("../src/store.ts");
  const store = makeOnePasswordSecretStore({
    run: () => Effect.succeed({ ...output, exitCode: 1, stderr, timedOut }),
  });
  // When
  const results = await Effect.runPromise(
    Effect.all([
      Effect.either(Effect.asVoid(store.get(reference))),
      Effect.either(Effect.asVoid(store.has(reference))),
    ]),
  );
  // Then
  for (const result of results) {
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "SecretStoreUnavailableError",
        storeId: "1password",
        reason,
      });
      expect(JSON.stringify(result.left)).not.toContain("sensitive-stderr");
      expect(JSON.stringify(result.left)).not.toContain("sentinel-sensitive-output");
    }
  }
});

test.each(["BARE", "env://Vault/Item/field", "op://Vault//field", "op://Vault/../field"])(
  "rejects invalid or non-op reference %s locally",
  async (invalid) => {
    // Given
    const { makeOnePasswordSecretStore } = await import("../src/store.ts");
    let calls = 0;
    const store = makeOnePasswordSecretStore({
      run: () =>
        Effect.sync(() => {
          calls++;
          return output;
        }),
    });
    // When
    const result = await Effect.runPromise(Effect.either(store.get(invalid)));
    // Then
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "SecretReferenceInvalidError", reference: invalid },
    });
    expect(calls).toBe(0);
  },
);

test("list returns only refs resolved in this process and reuses cached values", async () => {
  // Given
  const { makeOnePasswordSecretStore } = await import("../src/store.ts");
  let calls = 0;
  const run: OpRunner = () =>
    Effect.sync(() => {
      calls++;
      return output;
    });
  const store = makeOnePasswordSecretStore({ run });
  const untouched = makeOnePasswordSecretStore({ run });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const before = yield* store.list;
      const first = yield* store.get(reference);
      const second = yield* store.get(reference);
      return { before, first, second, after: yield* store.list, untouched: yield* untouched.list };
    }),
  );
  // Then
  expect(result).toEqual({
    before: [],
    first: output.stdout,
    second: output.stdout,
    after: [reference],
    untouched: [],
  });
  expect(calls).toBe(1);
});

test("missing secrets stay absent without caching failed reads", async () => {
  // Given
  const { makeOnePasswordSecretStore } = await import("../src/store.ts");
  let calls = 0;
  const store = makeOnePasswordSecretStore({
    run: () =>
      Effect.sync(() => {
        calls++;
        return { ...output, exitCode: 1, stderr: "couldn't find item" };
      }),
  });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        get: yield* Effect.either(store.get(reference)),
        has: yield* store.has(reference),
        list: yield* store.list,
      };
    }),
  );
  // Then
  expect(result.get).toMatchObject({
    _tag: "Left",
    left: { _tag: "SecretNotFoundError", secret: reference },
  });
  expect(result.has).toBe(false);
  expect(result.list).toEqual([]);
  expect(calls).toBe(2);
});

test.each([
  {
    error: new ProcessExecError({ message: "spawn failed", cmd: "op", cause: { code: "ENOENT" } }),
    reason: "cli-missing",
  },
  { error: new ProcessExecError({ message: "spawn failed", cmd: "op", errno: -2 }), reason: "cli-missing" },
  {
    error: new ProcessExecError({ message: "Executable not found in $PATH: op", cmd: "op" }),
    reason: "cli-missing",
  },
  {
    error: new ProcessExecError({ message: "EACCES sensitive-stderr", cmd: "op", errno: -13 }),
    reason: "denied",
  },
  {
    error: new ProcessTimeoutError({ message: "sensitive-stderr", cmd: "op", elapsedMs: 120_000 }),
    reason: "timeout",
  },
])("ProcessRunner failure maps to $reason", async ({ error, reason }) => {
  // Given
  const { onePasswordSecretStore } = await import("../src/store.ts");
  const runner = ProcessRunner.of({
    run: () => Effect.fail(error),
    stream: () => Stream.empty,
    streamWithExit: () => Stream.empty,
  });
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SecretStore;
      return yield* Effect.either(store.get(reference));
    }).pipe(Effect.provide(onePasswordSecretStore), Effect.provideService(ProcessRunner, runner)),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { _tag: "SecretStoreUnavailableError", reason } });
  expect(JSON.stringify(result)).not.toContain("sensitive-stderr");
});

test("adapter passes argv and timeout but suppresses secret-bearing process events", async () => {
  // Given
  const { makeOpRunner } = await import("../src/op-cli.ts");
  const calls: ProcessSpawnOptions[] = [];
  const published: unknown[] = [];
  const runner = {
    run: (input: ProcessSpawnOptions) =>
      Effect.gen(function* () {
        calls.push(input);
        const events = yield* Effect.serviceOption(EventService);
        if (Option.isSome(events))
          yield* events.value
            .publish({ _tag: "post-process-exec", cmd: "op", args: input.args, ...output })
            .pipe(Effect.ignore);
        return output;
      }),
  };
  const events = EventService.of({
    publish: (event) =>
      Effect.sync(() => {
        published.push(event);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.die("unused"),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  });
  // When
  const value = await Effect.runPromise(
    makeOpRunner(runner)(["read", "--no-newline", reference], { timeoutMs: 37 }).pipe(
      Effect.provideService(EventService, events),
    ),
  );
  // Then
  expect(value.stdout).toBe(output.stdout);
  expect(calls).toEqual([{ cmd: "op", args: ["read", "--no-newline", reference], timeoutMs: 37 }]);
  expect(published).toEqual([]);
});

test("interrupting a read cancels the process effect without caching a value", async () => {
  // Given
  const { makeOnePasswordSecretStore } = await import("../src/store.ts");
  const started = await Effect.runPromise(Deferred.make<void>());
  let cancelled = false;
  const store = makeOnePasswordSecretStore({
    run: () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.zipRight(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cancelled = true;
          }),
        ),
      ),
  });
  // When
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(store.get(reference));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
    }),
  );
  // Then
  expect(cancelled).toBe(true);
  expect(await Effect.runPromise(store.list)).toEqual([]);
});
