import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";

import { SecretNotFoundError } from "@lando/core/errors";
import { EventService } from "@lando/core/services";
import { createRedactor } from "@lando/sdk/secrets";
import type { LandoEvent, ShellReplInput } from "@lando/sdk/services";

import { RedactionService } from "../../src/redaction/service.ts";
import { hostShellEvaluatorArgv, runHostShellLine } from "../../src/services/host-shell-line.ts";
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

test("the evaluator argv contains static code but never the command text", () => {
  expect(hostShellEvaluatorArgv().join(" ")).not.toContain("unique-secret-command-text");
});

test("an already-aborted line is never sent to the evaluator", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-host-repl-aborted-"));
  const marker = join(root, "sent");
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await runHostShellLine({
      line: `printf sent > '${marker}'`,
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
    line: 'printf "%s" "$BUN_BE_BUN"',
    writeStdout: stdout.push.bind(stdout),
    writeStderr: () => {},
  });

  expect(result.exitCode).toBe(0);
  expect(stdout.join("")).toBe("");
});
