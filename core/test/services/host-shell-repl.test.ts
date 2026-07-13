import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";

import { SecretNotFoundError } from "@lando/core/errors";
import { EventService } from "@lando/core/services";
import { createRedactor } from "@lando/sdk/secrets";
import type { LandoEvent, ShellReplInput } from "@lando/sdk/services";

import { RedactionService } from "../../src/redaction/service.ts";
import { hostShellEvaluatorArgv, runHostShellLine } from "../../src/services/host-shell-line.ts";
import { makeStatefulShellRedactor } from "../../src/services/host-shell-redactor.ts";
import { runHostShellRepl } from "../../src/services/host-shell-repl.ts";

const input = (...events: ReadonlyArray<ShellReplInput>): AsyncIterable<ShellReplInput> =>
  (async function* () {
    yield* events;
  })();

const replIo = (
  events: ReadonlyArray<ShellReplInput>,
  callbacks: { readonly stdout?: () => void; readonly close?: () => void } = {},
) => ({
  input: input(...events),
  writeStdout: callbacks.stdout ?? (() => {}),
  writeStderr: () => {},
  ...(callbacks.close === undefined ? {} : { close: callbacks.close }),
});

const eventLayer = (events: LandoEvent[]) =>
  Layer.succeed(EventService, {
    publish: (event: LandoEvent) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<never>(),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  });

test("canonical redaction covers literal secrets in output, events, and history", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-redaction-"));
  const historyFile = join(root, "history");
  const events: LandoEvent[] = [];
  const stdout: string[] = [];
  try {
    await Effect.runPromise(
      runHostShellRepl({
        historyFile,
        resolveSecret: () => Effect.die("secret not expected"),
        io: {
          input: input({ _tag: "line", line: "printf topsecret" }, { _tag: "eof" }),
          writeStdout: stdout.push.bind(stdout),
          writeStderr: () => {},
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            eventLayer(events),
            Layer.succeed(RedactionService, {
              forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
            }),
          ),
        ),
      ),
    );

    const retained = `${stdout.join("")}\n${JSON.stringify(events)}\n${await readFile(historyFile, "utf8")}`;
    expect(retained).toContain("[redacted]");
    expect(retained).not.toContain("topsecret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolved secrets remain Bun Shell interpolations instead of executable syntax", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-secret-syntax-"));
  const marker = join(root, "injected");
  const stdout: string[] = [];
  const secret = `safe; printf injected > '${marker}'`;

  try {
    // When
    const result = await Effect.runPromise(
      runHostShellRepl({
        cwd: root,
        resolveSecret: () => Effect.succeed(secret),
        io: {
          input: input({ _tag: "line", line: "printf '%s' ${secret:TOKEN}" }, { _tag: "eof" }),
          writeStdout: stdout.push.bind(stdout),
          writeStderr: () => {},
        },
      }),
    );

    // Then
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(stdout.join("").trim()).toBe("[redacted]");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret resolution preserves JavaScript replacement tokens literally", async () => {
  // Given
  const secret = "$&$`$'";
  const stdout: string[] = [];

  // When
  const result = await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: () => Effect.succeed(secret),
      io: {
        input: input({ _tag: "line", line: "printf '%s' ${secret:TOKEN}" }, { _tag: "eof" }),
        writeStdout: stdout.push.bind(stdout),
        writeStderr: () => {},
      },
    }),
  );

  // Then
  expect(result.exitCode).toBe(0);
  expect(stdout.join("").trim()).toBe("[redacted]");
});

test("resolved secrets split across output chunks are withheld until safely redacted", async () => {
  // Given
  const stdout: string[] = [];

  // When
  await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: () => Effect.succeed("split-secret"),
      io: {
        input: input(
          {
            _tag: "line",
            line: "bun -e 'const s = process.argv[1]; process.stdout.write(s.slice(0, 6)); await Bun.sleep(20); process.stdout.write(s.slice(6))' ${secret:TOKEN}",
          },
          { _tag: "eof" },
        ),
        writeStdout: stdout.push.bind(stdout),
        writeStderr: () => {},
      },
    }),
  );

  // Then
  expect(stdout.join("").trim()).toBe("[redacted]");
  expect(stdout).not.toContain("split-");
  expect(stdout.join("")).not.toContain("split-secret");
});

test("secret-shaped env values split across output chunks never reach IO", async () => {
  // Given
  const stdout: string[] = [];

  // When
  await Effect.runPromise(
    runHostShellRepl({
      env: { API_TOKEN: "env-split-secret" },
      resolveSecret: () => Effect.die("secret not expected"),
      io: {
        input: input(
          {
            _tag: "line",
            line: "bun -e 'const s = process.env.API_TOKEN; process.stdout.write(s.slice(0, 4)); await Bun.sleep(20); process.stdout.write(s.slice(4))'",
          },
          { _tag: "eof" },
        ),
        writeStdout: stdout.push.bind(stdout),
        writeStderr: () => {},
      },
    }),
  );

  // Then
  expect(stdout.join("").trim()).toBe("[redacted]");
  expect(stdout).not.toContain("env-");
  expect(stdout.join("")).not.toContain("env-split-secret");
});

test("resolved secrets split across stdout and stderr never reach either IO stream", async () => {
  // Given
  const stdout: string[] = [];
  const stderr: string[] = [];

  // When
  await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: () => Effect.succeed("split-secret"),
      io: {
        input: input(
          {
            _tag: "line",
            line: "bun -e 'const s = process.argv[1]; process.stdout.write(s.slice(0, 6)); process.stderr.write(s.slice(6))' ${secret:TOKEN}",
          },
          { _tag: "eof" },
        ),
        writeStdout: stdout.push.bind(stdout),
        writeStderr: stderr.push.bind(stderr),
      },
    }),
  );

  // Then
  expect(`${stdout.join("")}${stderr.join("")}`).toContain("[redacted]");
  expect(stdout).not.toContain("split-");
  expect(stderr).not.toContain("secret");
});

test("captured redacted output remains bounded", () => {
  // Given
  const stream = makeStatefulShellRedactor(
    { redactString: (text) => text, redactValue: (value) => value },
    [],
    () => {},
  );

  // When
  stream.push("stdout", "x".repeat(100_000));
  stream.flush();

  // Then
  expect(stream.captured("stdout").length).toBeLessThanOrEqual(65_536);
});

test("missing secret rejects only that line and the REPL continues without event leakage", async () => {
  const events: LandoEvent[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: (id) =>
        Effect.fail(new SecretNotFoundError({ message: "missing", secret: id, remediation: "set it" })),
      io: {
        input: input(
          { _tag: "line", line: "printf '${secret:MISSING}'" },
          { _tag: "line", line: "printf survived" },
          { _tag: "eof" },
        ),
        writeStdout: stdout.push.bind(stdout),
        writeStderr: stderr.push.bind(stderr),
      },
    }).pipe(Effect.provide(eventLayer(events))),
  );

  expect(result.exitCode).toBe(0);
  expect(stdout.join("")).toContain("survived");
  expect(stderr.join("")).toContain("missing");
  expect(events.map((event) => event._tag)).toEqual(["pre-shell-exec", "post-shell-exec"]);
  expect(JSON.stringify(events)).not.toContain("MISSING");
});

test("Ctrl+C interrupts only the active line with status 130 and accepts the next line", async () => {
  const events: LandoEvent[] = [];
  const stdout: string[] = [];
  const delayedInput = (async function* (): AsyncIterable<ShellReplInput> {
    yield { _tag: "line", line: "sleep ${secret:WAIT}" };
    await Bun.sleep(50);
    yield { _tag: "interrupt" };
    yield { _tag: "line", line: "printf after-interrupt" };
    yield { _tag: "eof" };
  })();
  const result = await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: () => Effect.succeed("10"),
      io: {
        input: delayedInput,
        writeStdout: stdout.push.bind(stdout),
        writeStderr: () => {},
      },
    }).pipe(Effect.provide(eventLayer(events))),
  );

  expect(result.exitCode).toBe(0);
  expect(stdout.join("")).toContain("after-interrupt");
  expect(events.filter((event) => event._tag === "post-shell-exec").map((event) => event.exitCode)).toEqual([
    130, 0,
  ]);
  expect(JSON.stringify(events)).not.toContain("${secret:WAIT}");
  expect(JSON.stringify(events)).toContain("[redacted]");
});

test("exit uses last status, explicit exit overrides it, and terminal cleanup always runs", async () => {
  const closes: undefined[] = [];
  const result = await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: () => Effect.die("secret not expected"),
      io: {
        input: input({ _tag: "line", line: "exit 23" }),
        writeStdout: () => {},
        writeStderr: () => {},
        close: closes.push.bind(closes, undefined),
      },
    }),
  );

  expect(result.exitCode).toBe(23);
  expect(closes).toHaveLength(1);
});

test("explicit exit codes normalize to the portable 8-bit range", async () => {
  const result = await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: () => Effect.die("secret not expected"),
      io: replIo([{ _tag: "line", line: "exit 300" }]),
    }),
  );

  expect(result.exitCode).toBe(44);
});

test("negative explicit exit codes normalize to the portable 8-bit range", async () => {
  const result = await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: () => Effect.die("secret not expected"),
      io: replIo([{ _tag: "line", line: "exit -1" }]),
    }),
  );

  expect(result.exitCode).toBe(255);
});

test("exit does not prefetch another iterator item", async () => {
  // Given
  let reads = 0;
  const iterable: AsyncIterable<ShellReplInput> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve({ done: false, value: { _tag: "line", line: "exit" } });
        }
        return Promise.reject(new Error("unexpected prefetched read"));
      },
    }),
  };

  // When
  const result = await Effect.runPromise(
    runHostShellRepl({
      resolveSecret: () => Effect.die("secret not expected"),
      io: { input: iterable, writeStdout: () => {}, writeStderr: () => {} },
    }),
  );

  // Then
  expect(result.exitCode).toBe(0);
  expect(reads).toBe(1);
});

test("history read failure closes terminal IO exactly once", async () => {
  // Given
  const closes: undefined[] = [];

  // When
  const exit = await Effect.runPromiseExit(
    runHostShellRepl({
      historyFile: "history\0invalid",
      resolveSecret: () => Effect.die("secret not expected"),
      io: replIo([{ _tag: "eof" }], { close: closes.push.bind(closes, undefined) }),
    }),
  );

  // Then
  expect(exit._tag).toBe("Failure");
  expect(closes).toHaveLength(1);
});

test("launch failure emits a redacted post event with non-zero status", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-launch-history-"));
  const historyFile = join(root, "history");
  const secret = "launch-failure-secret";
  const events: LandoEvent[] = [];
  await Bun.write(historyFile, "discarded-history\n");

  try {
    // When
    const exit = await Effect.runPromiseExit(
      runHostShellRepl({
        cwd: "cwd\0invalid",
        historyFile,
        historyLimit: 1,
        resolveSecret: () => Effect.succeed(secret),
        io: replIo([{ _tag: "line", line: "printf '${secret:TOKEN}'" }]),
      }).pipe(Effect.provide(eventLayer(events))),
    );

    // Then
    const history = await readFile(historyFile, "utf8");
    const retained = `${JSON.stringify({ events, exit })}\n${history}`;
    expect(events.map((event) => event._tag)).toEqual(["pre-shell-exec", "post-shell-exec"]);
    const post = events.find((event) => event._tag === "post-shell-exec");
    expect(post?._tag === "post-shell-exec" ? post.exitCode : 0).not.toBe(0);
    expect(history.trim()).toBe("printf '[redacted]'");
    expect(retained).toContain("[redacted]");
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain("${secret:TOKEN}");
    expect(retained).not.toContain("discarded-history");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Effect interruption aborts the active child and closes terminal IO", async () => {
  // Given
  const closes: undefined[] = [];

  // When
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.fork(
        runHostShellRepl({
          resolveSecret: () => Effect.die("secret not expected"),
          io: replIo([{ _tag: "line", line: "printf ready; sleep 5" }], {
            stdout: () => Effect.runSync(Deferred.succeed(ready, undefined)),
            close: closes.push.bind(closes, undefined),
          }),
        }),
      );
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
    }),
  );

  // Then
  expect(closes).toHaveLength(1);
});

test("spec abort stops the active child and closes terminal IO", async () => {
  // Given
  const controller = new AbortController();
  const closes: undefined[] = [];

  // When
  const result = await Effect.runPromise(
    runHostShellRepl({
      signal: controller.signal,
      resolveSecret: () => Effect.die("secret not expected"),
      io: replIo([{ _tag: "line", line: "printf ready; sleep 5" }], {
        stdout: () => controller.abort(),
        close: closes.push.bind(closes, undefined),
      }),
    }),
  );

  // Then
  expect(result.exitCode).toBe(130);
  expect(closes).toHaveLength(1);
});

test("active abort does not await iterator return or leak a late pending-read rejection", async () => {
  // Given
  const controller = new AbortController();
  const unhandled: unknown[] = [];
  let reads = 0;
  let returns = 0;
  let rejectPending: ((reason?: unknown) => void) | undefined;
  const pendingRead = new Promise<IteratorResult<ShellReplInput>>((_resolve, reject) => {
    rejectPending = reject;
  });
  const iterable: AsyncIterable<ShellReplInput> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve({ done: false, value: { _tag: "line", line: "sleep 5" } });
        }
        controller.abort();
        return pendingRead;
      },
      return: () => {
        returns += 1;
        return new Promise<IteratorResult<ShellReplInput>>(() => {});
      },
    }),
  };
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    // When
    const result = await Effect.runPromise(
      runHostShellRepl({
        signal: controller.signal,
        resolveSecret: () => Effect.die("secret not expected"),
        io: {
          input: iterable,
          writeStdout: () => {},
          writeStderr: () => {},
        },
      }),
    );
    rejectPending?.(new Error("late pending read failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Then
    expect(result.exitCode).toBe(130);
    expect(returns).toBe(1);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}, 1_000);

test("spec abort while idle finalizes input and returns status 130", async () => {
  // Given
  const controller = new AbortController();
  const closes: undefined[] = [];
  const returns: undefined[] = [];
  const iterable: AsyncIterable<ShellReplInput> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<ShellReplInput>>(() => {}),
      return: () => {
        returns.push(undefined);
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };

  // When
  const running = Effect.runPromise(
    runHostShellRepl({
      signal: controller.signal,
      resolveSecret: () => Effect.die("secret not expected"),
      io: {
        input: iterable,
        writeStdout: () => {},
        writeStderr: () => {},
        close: closes.push.bind(closes, undefined),
      },
    }),
  );
  controller.abort();
  const result = await running;

  // Then
  expect(result.exitCode).toBe(130);
  expect(closes).toHaveLength(1);
  expect(returns).toHaveLength(1);
});

test("the evaluator argv contains static code but never the command text", () => {
  expect(hostShellEvaluatorArgv().join(" ")).not.toContain("unique-secret-command-text");
  if (process.platform !== "win32") expect(hostShellEvaluatorArgv()).toContain("--no-orphans");
});

test("aborting a line reaps evaluator descendants before returning", async () => {
  if (process.platform === "win32") return;

  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-descendants-"));
  const pidFile = join(root, "pid");
  const controller = new AbortController();

  try {
    // When
    const result = await runHostShellLine({
      fragments: [`sh -c 'sleep 30 & echo $! > "${pidFile}"; echo ready; wait'`],
      values: [],
      cwd: root,
      signal: controller.signal,
      writeStdout: () => controller.abort(),
      writeStderr: () => {},
    });
    const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    let alive = true;
    try {
      process.kill(pid, 0);
      const stat = await Bun.file(`/proc/${pid}/stat`).text();
      alive = stat.split(" ")[2] !== "Z";
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && (cause.code === "ESRCH" || cause.code === "ENOENT")) {
        alive = false;
      } else throw cause;
    }
    if (alive) process.kill(pid, "SIGKILL");

    // Then
    expect(result.exitCode).toBe(130);
    expect(alive).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent sessions append bounded history without losing entries", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-concurrent-history-"));
  const historyFile = join(root, "history");

  try {
    // When
    await Promise.all(
      ["first", "second"].map((value) =>
        Effect.runPromise(
          runHostShellRepl({
            historyFile,
            historyLimit: 2,
            resolveSecret: () => Effect.die("secret not expected"),
            io: replIo([{ _tag: "line", line: `printf ${value}` }, { _tag: "eof" }]),
          }),
        ),
      ),
    );

    // Then
    expect((await readFile(historyFile, "utf8")).trim().split("\n").sort()).toEqual([
      "printf first",
      "printf second",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history limit zero persists and retains no entries", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-zero-history-"));
  const historyFile = join(root, "history");
  await Bun.write(historyFile, "old\n");

  try {
    // When
    await Effect.runPromise(
      runHostShellRepl({
        historyFile,
        historyLimit: 0,
        resolveSecret: () => Effect.die("secret not expected"),
        io: replIo([{ _tag: "line", line: "printf new" }, { _tag: "eof" }]),
      }),
    );

    // Then
    expect(await readFile(historyFile, "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history files retain private 0600 permissions", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-private-history-"));
  const historyFile = join(root, "history");

  try {
    // When
    await Effect.runPromise(
      runHostShellRepl({
        historyFile,
        resolveSecret: () => Effect.die("secret not expected"),
        io: replIo([{ _tag: "line", line: "printf private" }, { _tag: "eof" }]),
      }),
    );

    // Then
    expect((await stat(historyFile)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an already-aborted line is never sent to the evaluator", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-aborted-"));
  const marker = join(root, "sent");
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await runHostShellLine({
      fragments: [`printf sent > '${marker}'`],
      values: [],
      cwd: root,
      signal: controller.signal,
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(130);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the evaluator bootstrap marker is absent from the user command environment", async () => {
  const stdout: string[] = [];
  const result = await runHostShellLine({
    fragments: ['printf "%s" "$BUN_BE_BUN"'],
    values: [],
    writeStdout: stdout.push.bind(stdout),
    writeStderr: () => {},
  });

  expect(result.exitCode).toBe(0);
  expect(stdout.join("")).toBe("");
});
