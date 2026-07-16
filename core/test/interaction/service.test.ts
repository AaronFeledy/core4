import { Readable, Writable } from "node:stream";
import { ReadStream } from "node:tty";

import { afterEach, describe, expect, test } from "bun:test";

import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Redacted, type Scope } from "effect";

import { ChoicesUnavailableError } from "@lando/sdk/errors";
import { Logger, Renderer } from "@lando/sdk/services";

import { makeRendererServiceLiveForMode } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { resetInteractivePromptDegradationForTest } from "../../src/interaction/interactive-driver.ts";
import {
  makeDefaultResolveInteractionDriver,
  makeInteractionService,
} from "../../src/interaction/service.ts";

type RendererService = Context.Tag.Service<typeof Renderer>;

const scriptedStdin = (lines: ReadonlyArray<string>): NodeJS.ReadableStream =>
  Readable.from(lines.map((line) => `${line}\n`));

const neverStdin = (): NodeJS.ReadableStream =>
  new Readable({
    read() {
      // never push — readLine blocks until the fiber is interrupted
    },
  });

const capturingWritable = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
};

const capturingRenderer = (id = "plain") => {
  let out = "";
  let err = "";
  const service: RendererService = {
    id,
    message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
    output: {
      stdout: (chunk: string) =>
        Effect.sync(() => {
          out += chunk;
        }),
      stderr: (chunk: string) =>
        Effect.sync(() => {
          err += chunk;
        }),
    },
  };
  return { service, out: () => out, err: () => err };
};

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const runScopedExit = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.scoped(effect));

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { _tag?: string })._tag : undefined;
};

afterEach(() => {
  resetInteractivePromptDegradationForTest();
});

describe("InteractionServiceLive — answer-source precedence", () => {
  test("explicit answer wins over prompting", async () => {
    const service = makeInteractionService({ stdin: neverStdin() });
    const answers = await runScoped(
      service.promptAll([{ name: "app", type: "text", message: "Name?" }], {
        answers: { app: "blog" },
        interactive: false,
      }),
    );
    expect(answers).toEqual({ app: "blog" });
  });

  test("non-interactive with no default fails with InteractionRequiredError", async () => {
    const service = makeInteractionService({ stdin: neverStdin() });
    const exit = await runScopedExit(
      service.promptAll([{ name: "app", type: "text", message: "Name?" }], { interactive: false }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("InteractionRequiredError");
  });

  test("--yes resolves the recipe default", async () => {
    const service = makeInteractionService({ stdin: neverStdin() });
    const answers = await runScoped(
      service.promptAll([{ name: "app", type: "text", message: "Name?", default: "default-app" }], {
        yes: true,
      }),
    );
    expect(answers).toEqual({ app: "default-app" });
  });

  test("sequential batches on one service share a single stdin reader (no lost buffered input)", async () => {
    // One push delivers BOTH answers: a per-call reader would strand "second" at EOF.
    const single = new Readable();
    single.push("first\nsecond\n");
    single.push(null);
    const service = makeInteractionService({ stdin: single, stdout: capturingWritable().stream });
    const a = await runScoped(
      service.promptAll([{ name: "one", type: "text", message: "One?" }], { interactive: true }),
    );
    const b = await runScoped(
      service.promptAll([{ name: "two", type: "text", message: "Two?" }], { interactive: true }),
    );
    expect(a).toEqual({ one: "first" });
    expect(b).toEqual({ two: "second" });
  });

  test("interactive resolution reads scripted stdin", async () => {
    const capture = capturingWritable();
    const service = makeInteractionService({ stdin: scriptedStdin(["typed-value"]), stdout: capture.stream });
    const answers = await runScoped(
      service.promptAll([{ name: "app", type: "text", message: "Name?" }], { interactive: true }),
    );
    expect(answers).toEqual({ app: "typed-value" });
  });

  test("defaultMode non-interactive overrides the auto-on-TTY default for an empty batch", async () => {
    // On a TTY stdin the implicit `auto` default would read stdin; defaultMode
    // non-interactive must instead fail fast on an unseeded required prompt.
    const ttyStdin = scriptedStdin(["should-not-be-read"]);
    Object.assign(ttyStdin, { isTTY: true });
    const service = makeInteractionService({
      stdin: ttyStdin,
      stdout: capturingWritable().stream,
      defaultMode: "non-interactive",
    });
    const exit = await runScopedExit(service.promptAll([{ name: "app", type: "text", message: "Name?" }]));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("InteractionRequiredError");
  });

  test("per-batch mode overrides defaultMode", async () => {
    const ttyStdin = scriptedStdin(["typed"]);
    Object.assign(ttyStdin, { isTTY: true });
    const capture = capturingWritable();
    const service = makeInteractionService({
      stdin: ttyStdin,
      stdout: capture.stream,
      defaultMode: "non-interactive",
    });
    const answers = await runScoped(
      service.promptAll([{ name: "app", type: "text", message: "Name?" }], { mode: "interactive" }),
    );
    expect(answers).toEqual({ app: "typed" });
  });

  test("auto mode is non-interactive when stdin is not a TTY", async () => {
    const service = makeInteractionService({ stdin: neverStdin() });
    const interactive = await Effect.runPromise(service.isInteractive);
    expect(interactive).toBe(false);
    const exit = await runScopedExit(
      service.promptAll([{ name: "app", type: "text", message: "Name?" }], { mode: "auto" }),
    );
    expect(failureTag(exit)).toBe("InteractionRequiredError");
  });

  test("isInteractive uses structural TTY detection for injected streams", async () => {
    const fakeTty = new Readable({ read() {} });
    Object.assign(fakeTty, { isTTY: true });
    const service = makeInteractionService({ stdin: fakeTty });

    await expect(Effect.runPromise(service.isInteractive)).resolves.toBe(true);
  });

  test("answersFile is merged below explicit answers", async () => {
    const { tmpdir } = await import("node:os");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "lando-answers-"));
    const file = join(dir, "answers.json");
    await writeFile(file, JSON.stringify({ app: "from-file", region: "us" }), "utf8");
    const service = makeInteractionService({ stdin: neverStdin() });
    const answers = await runScoped(
      service.promptAll(
        [
          { name: "app", type: "text", message: "App?" },
          { name: "region", type: "text", message: "Region?" },
        ],
        { answersFile: file, answers: { app: "explicit-wins" }, interactive: false },
      ),
    );
    expect(answers).toEqual({ app: "explicit-wins", region: "us" });
  });

  test("relative answersFile resolves against the prompt batch cwd", async () => {
    const { tmpdir } = await import("node:os");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "lando-answers-cwd-"));
    await writeFile(join(dir, "answers.json"), JSON.stringify({ app: "from-cwd" }), "utf8");
    const service = makeInteractionService({ stdin: neverStdin() });

    const answers = await runScoped(
      service.promptAll([{ name: "app", type: "text", message: "App?" }], {
        answersFile: "answers.json",
        cwd: dir,
        interactive: false,
      }),
    );

    expect(answers).toEqual({ app: "from-cwd" });
  });

  test("promptAll forwards the runs allowlist to dynamic choicesFrom prompts", async () => {
    let invoked = 0;
    const service = makeInteractionService({
      stdin: neverStdin(),
      choicesRunner: async () => {
        invoked += 1;
        return { exitCode: 0, stdout: "8.3\n", stderr: "" };
      },
    });

    const exit = await runScopedExit(
      service.promptAll(
        [
          {
            name: "phpVersion",
            type: "select",
            message: "PHP version?",
            choicesFrom: { command: "services:list", args: ["--type=php"], parse: "lines" },
          },
        ],
        { interactive: false, runs: ["git"] },
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    expect(Option.isSome(failure) ? failure.value : undefined).toBeInstanceOf(ChoicesUnavailableError);
    if (Option.isSome(failure) && failure.value instanceof ChoicesUnavailableError) {
      expect(failure.value.command).toBe("services:list");
      expect(failure.value.message).toContain("runs: allowlist");
    }
    expect(invoked).toBe(0);
  });

  test("promptAll accepts a batch-scoped choicesRunner override", async () => {
    let invoked = 0;
    const service = makeInteractionService({
      stdin: scriptedStdin(["8.3"]),
      stdout: capturingWritable().stream,
    });

    const answers = await runScoped(
      service.promptAll(
        [
          {
            name: "phpVersion",
            type: "select",
            message: "PHP version?",
            choicesFrom: { command: "services:list", args: ["--type=php"], parse: "lines" },
          },
        ],
        {
          interactive: true,
          choicesRunner: async () => {
            invoked += 1;
            return { exitCode: 0, stdout: "8.2\n8.3\n", stderr: "" };
          },
        } as Parameters<typeof service.promptAll>[1] & { choicesRunner: unknown },
      ),
    );

    expect(answers).toEqual({ phpVersion: "8.3" });
    expect(invoked).toBe(1);
  });
});

describe("InteractionServiceLive — rich driver wiring (S2)", () => {
  test("the default resolver loads the rich driver when an interactive TTY gate passes", async () => {
    const resolve = makeDefaultResolveInteractionDriver({
      env: {},
      importRendererPlugin: async () => ({
        loadInteractivePromptDriver: async () => ({ readRaw: async () => "from-driver" }),
      }),
    });
    const driver = await resolve({ isTTY: true, yes: false, nonInteractive: false });
    expect(driver).toBeDefined();
    expect(
      await driver?.readRaw({
        prompt: { name: "name", type: "text", message: "Name?" },
        mode: "normal",
      }),
    ).toBe("from-driver");
  });

  test("the default resolver bypasses the driver under --yes / non-interactive / non-TTY", async () => {
    let importAttempts = 0;
    const resolve = makeDefaultResolveInteractionDriver({
      env: {},
      importRendererPlugin: async () => {
        importAttempts += 1;
        return { loadInteractivePromptDriver: async () => ({ readRaw: async () => "x" }) };
      },
    });
    expect(await resolve({ isTTY: true, yes: true, nonInteractive: false })).toBeUndefined();
    expect(await resolve({ isTTY: true, yes: false, nonInteractive: true })).toBeUndefined();
    expect(await resolve({ isTTY: false, yes: false, nonInteractive: false })).toBeUndefined();
    expect(importAttempts).toBe(0);
  });

  test("awaits one degradation notice through the caller logger runtime", async () => {
    const ttyStdin = scriptedStdin(["line-answer"]);
    Object.assign(ttyStdin, { isTTY: true });
    let releaseNotice: (() => void) | undefined;
    let markNoticeStarted: (() => void) | undefined;
    const noticeStarted = new Promise<void>((resolve) => {
      markNoticeStarted = resolve;
    });
    const noticeReleased = new Promise<void>((resolve) => {
      releaseNotice = resolve;
    });
    const notices: string[] = [];
    const logger: Context.Tag.Service<typeof Logger> = {
      debug: (message) =>
        Effect.promise(async () => {
          notices.push(message);
          markNoticeStarted?.();
          await noticeReleased;
        }),
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
    };
    const service = makeInteractionService({
      stdin: ttyStdin,
      stdout: capturingWritable().stream,
      resolveDriver: async (gate) => {
        await gate.debug?.("OpenTUI prompts degraded to line input for this process.", {
          cause: new Error("native renderer init failed"),
        });
        return undefined;
      },
    });
    let settled = false;

    const answer = runScoped(
      service.prompt({ name: "name", type: "text", message: "Name?" }).pipe(
        Effect.provideService(Logger, logger),
        Effect.ensuring(
          Effect.sync(() => {
            settled = true;
          }),
        ),
      ),
    );
    await noticeStarted;

    expect(settled).toBe(false);
    releaseNotice?.();
    await expect(answer).resolves.toBe("line-answer");
    expect(notices).toEqual(["OpenTUI prompts degraded to line input for this process."]);
  });

  test("the default service is constructed with a rich-driver seam", () => {
    expect(typeof makeDefaultResolveInteractionDriver).toBe("function");
  });

  test.each(["plain", "json"])("renderer %s bypasses the rich driver on an interactive TTY", async (id) => {
    let resolveAttempts = 0;
    const ttyStdin = scriptedStdin(["line-answer"]);
    Object.assign(ttyStdin, { isTTY: true });
    const service = makeInteractionService({
      stdin: ttyStdin,
      resolveDriver: async () => {
        resolveAttempts += 1;
        return { readRaw: async () => "rich-answer" };
      },
    });
    const renderer = capturingRenderer(id);
    const baselineStdin = scriptedStdin(["line-answer"]);
    Object.assign(baselineStdin, { isTTY: true });
    const baselineService = makeInteractionService({ stdin: baselineStdin });
    const baselineRenderer = capturingRenderer(id);

    const answer = await runScoped(
      service
        .prompt({ name: "name", type: "text", message: "Name?" })
        .pipe(Effect.provide(Layer.succeed(Renderer, renderer.service))),
    );
    const baselineAnswer = await runScoped(
      baselineService
        .prompt({ name: "name", type: "text", message: "Name?" })
        .pipe(Effect.provide(Layer.succeed(Renderer, baselineRenderer.service))),
    );

    expect(answer).toBe("line-answer");
    expect(baselineAnswer).toBe("line-answer");
    expect(resolveAttempts).toBe(0);
    expect(renderer.out()).toBe(baselineRenderer.out());
  });
});

describe("InteractionServiceLive — secret redaction", () => {
  test("secret returns a Redacted value and never echoes the input", async () => {
    const capture = capturingWritable();
    const service = makeInteractionService({ stdin: scriptedStdin(["hunter2"]), stdout: capture.stream });
    const value = await runScoped(service.secret({ message: "Password?", interactive: true }));
    expect(Redacted.value(value)).toBe("hunter2");
    expect(String(value)).not.toContain("hunter2");
    expect(JSON.stringify(value)).not.toContain("hunter2");
    expect(capture.text()).not.toContain("hunter2");
    expect(capture.text()).toContain("Password?");
  });
});

describe("InteractionServiceLive — confirm and select", () => {
  test("confirm coerces an affirmative answer to true", async () => {
    const capture = capturingWritable();
    const service = makeInteractionService({ stdin: scriptedStdin(["y"]), stdout: capture.stream });
    const result = await runScoped(service.confirm({ message: "Proceed?", interactive: true }));
    expect(result).toBe(true);
  });

  test("select returns the chosen value by index", async () => {
    const capture = capturingWritable();
    const service = makeInteractionService({ stdin: scriptedStdin(["2"]), stdout: capture.stream });
    const result = await runScoped(
      service.select({ message: "Pick", choices: ["alpha", "beta", "gamma"], interactive: true }),
    );
    expect(result).toBe("beta");
  });
});

describe("InteractionServiceLive — renderer coordination", () => {
  test("prompt chrome routes through Renderer.output.stdout when a renderer is present", async () => {
    const renderer = capturingRenderer();
    const directStdout = capturingWritable();
    const service = makeInteractionService({
      stdin: scriptedStdin(["typed-value"]),
      stdout: directStdout.stream,
    });
    await runScoped(
      service
        .promptAll([{ name: "app", type: "text", message: "Routed?" }], { interactive: true })
        .pipe(Effect.provideService(Renderer, renderer.service)),
    );
    expect(renderer.out()).toContain("Routed?");
    expect(directStdout.text()).toBe("");
  });

  test("falls back to a direct stdio write when no renderer is active", async () => {
    const directStdout = capturingWritable();
    const service = makeInteractionService({
      stdin: scriptedStdin(["typed-value"]),
      stdout: directStdout.stream,
    });
    await runScoped(
      service.promptAll([{ name: "app", type: "text", message: "Direct?" }], { interactive: true }),
    );
    expect(directStdout.text()).toContain("Direct?");
  });

  test("every prompt-relevant renderer has synchronous output effects (Effect.runSync safe)", () => {
    for (const mode of ["plain", "lando", "verbose", "json"] as const) {
      const io = createBufferedRendererIO({ isTTY: false });
      expect(() =>
        Effect.runSync(
          Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(makeRendererServiceLiveForMode(mode, io));
              const renderer = Context.get(context, Renderer);
              yield* renderer.output.stdout("chrome");
              yield* renderer.output.stderr("diag");
            }),
          ),
        ),
      ).not.toThrow();
    }
  });
});

describe("InteractionServiceLive — interruption", () => {
  test("Effect.interrupt surfaces InteractionCancelledError", async () => {
    const service = makeInteractionService({ stdin: neverStdin(), stdout: capturingWritable().stream });
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(
            service.promptAll([{ name: "app", type: "text", message: "Name?" }], { interactive: true }),
          ),
        );
        yield* Effect.sleep("25 millis");
        return yield* Fiber.interrupt(fiber);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("InteractionCancelledError");
  });

  test("Effect.interrupt aborts the pending rich-driver read", async () => {
    const fakeTty = neverStdin();
    Object.setPrototypeOf(fakeTty, ReadStream.prototype);
    Object.assign(fakeTty, { isTTY: true });
    let receivedSignal: AbortSignal | undefined;
    let aborts = 0;
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const service = makeInteractionService({
      stdin: fakeTty,
      stdout: capturingWritable().stream,
      resolveDriver: async () => ({
        readRaw: async (_request, signal) => {
          receivedSignal = signal;
          markReadStarted?.();
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborts += 1;
                const error = new Error("cancelled");
                error.name = "PromptCancelledError";
                reject(error);
              },
              { once: true },
            );
          });
        },
      }),
    });

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(
            service.promptAll([{ name: "app", type: "text", message: "Name?" }], {
              interactive: true,
            }),
          ),
        );
        yield* Effect.promise(() => readStarted);
        return yield* Fiber.interrupt(fiber);
      }),
    );

    expect(failureTag(exit)).toBe("InteractionCancelledError");
    expect(receivedSignal?.aborted).toBe(true);
    expect(aborts).toBe(1);
  });

  test("interruption restores the prior TTY raw-mode state before propagating", async () => {
    const rawModeCalls: boolean[] = [];
    const fakeTty = new Readable({
      read() {
        // never push
      },
    });
    Object.assign(fakeTty, {
      isTTY: true,
      isRaw: true,
      setRawMode: (mode: boolean) => {
        rawModeCalls.push(mode);
        (fakeTty as unknown as { isRaw: boolean }).isRaw = mode;
      },
    });
    const service = makeInteractionService({ stdin: fakeTty, stdout: capturingWritable().stream });
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(
            service.promptAll([{ name: "app", type: "text", message: "Name?" }], { interactive: true }),
          ),
        );
        yield* Effect.sleep("25 millis");
        return yield* Fiber.interrupt(fiber);
      }),
    );
    expect(failureTag(exit)).toBe("InteractionCancelledError");
    expect(rawModeCalls).not.toContain(false);
    expect((fakeTty as unknown as { isRaw: boolean }).isRaw).toBe(true);
  });
});
