import { expect, test } from "bun:test";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createPayloadRedactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent, ShellRunner } from "@lando/sdk/services";
import { Effect, Exit, Layer, Queue, Stream } from "effect";
import {
  StreamFrameSink,
  type StreamFrameSinkFrame,
  createCollectingStreamFrameSink,
} from "../../src/operations/stream-frame-sink.ts";
import { landoLauncher } from "../../src/services/bun-command-env.ts";
import * as BunShellRunner from "../../src/services/shell-runner.ts";

const frameText = (frame: StreamFrameSinkFrame) =>
  typeof frame.chunk === "string" ? frame.chunk : new TextDecoder().decode(frame.chunk);

test("private script capture retains output without forwarding it to an ambient sink", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-script-private-"));
  const script = join(root, "private.bun.sh");
  const frames: StreamFrameSinkFrame[] = [];
  try {
    await writeFile(script, "printf private; printf diagnostic 1>&2\n");
    // When
    const result = await Effect.runPromise(
      Effect.flatMap(ShellRunner, (shell) => shell.runScript(script, { capture: true })).pipe(
        Effect.provide(
          BunShellRunner.layer(() => {
            throw new TypeError("Interactive IO must not be opened");
          }),
        ),
        Effect.provideService(StreamFrameSink, {
          emit: (frame) =>
            Effect.sync(() => {
              frames.push(frame);
            }),
        }),
      ),
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "private", stderr: "diagnostic" });
    expect(frames).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forwards unregistered assignments and binary script bytes without decoding", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-script-bytes-"));
  const script = join(root, "binary.bun.sh");
  const chunks: Uint8Array[] = [];
  const redaction = makeRedactionService();
  try {
    await writeFile(
      script,
      `echo PASSWORD=public; bun -e 'process.stdout.write(new Uint8Array([255,0,128]))'\n`,
    );
    // When
    const result = await Effect.runPromise(
      Effect.flatMap(ShellRunner, (shell) => shell.runScript(script)).pipe(
        Effect.provide(
          BunShellRunner.layer(() => {
            throw new TypeError("unused interactive IO");
          }),
        ),
        Effect.provideService(RedactionService, redaction),
        Effect.provideService(StreamFrameSink, {
          emit: (frame) =>
            Effect.sync(() => {
              expect(frame.chunk).toBeInstanceOf(Uint8Array);
              chunks.push(
                typeof frame.chunk === "string" ? new TextEncoder().encode(frame.chunk) : frame.chunk,
              );
            }),
        }),
      ),
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(new Uint8Array(chunks.flatMap((chunk) => [...chunk]))).toEqual(
      new Uint8Array([...new TextEncoder().encode("PASSWORD=public\n"), 255, 0, 128]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "reads inherited piped stdin through EOF when hostIo stdin is %s",
  async (inheritStdin) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-script-stdin-"));
    const scriptPath = join(root, "count.bun.sh");
    const runnerPath = resolve(import.meta.dirname, "../../src/services/shell-runner.ts");
    try {
      await writeFile(scriptPath, "wc -l\n");
      const helper = `
      import { Effect } from "effect";
      import { ShellRunner } from "@lando/sdk/services";
      import { layer } from ${JSON.stringify(runnerPath)};
      const result = await Effect.runPromise(Effect.flatMap(ShellRunner, shell =>
        shell.runScript(${JSON.stringify(scriptPath)}, ${inheritStdin ? '{ hostIo: "stdin" }' : "{}"})
      ).pipe(Effect.provide(layer(() => { throw new TypeError("unused interactive IO"); }))));
      process.stdout.write(result.stdout);
    `;
      // When
      const child = Bun.spawn([process.execPath, "-e", helper], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write("a\nb\nc\n");
      await child.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      // Then
      expect(code, stderr).toBe(0);
      expect(Number(stdout.trim())).toBe(inheritStdin ? 3 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("terminal host IO inherits input but routes output through the live sink", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-script-terminal-"));
  const scriptPath = join(root, "prompt.bun.sh");
  const runnerPath = resolve(import.meta.dirname, "../../src/services/shell-runner.ts");
  try {
    await writeFile(scriptPath, "echo -n 'name? '\necho to-stderr 1>&2\ncat\n");
    const helper = `
      import { Effect } from "effect";
      import { ShellRunner } from "@lando/sdk/services";
      import { layer } from ${JSON.stringify(runnerPath)};
      import { StreamFrameSink } from ${JSON.stringify(resolve(import.meta.dirname, "../../src/operations/stream-frame-sink.ts"))};
      const result = await Effect.runPromise(Effect.flatMap(ShellRunner, shell =>
        shell.runScript(${JSON.stringify(scriptPath)}, { hostIo: "terminal" })
      ).pipe(Effect.provide(layer(() => { throw new TypeError("unused interactive IO"); })),
        Effect.provideService(StreamFrameSink, { emit: frame => Effect.sync(() => process[frame._tag].write(frame.chunk)) })));
      process.stdout.write(JSON.stringify({ exitCode: result.exitCode, captured: result.stdout + result.stderr }));
    `;
    // When
    const child = Bun.spawn([process.execPath, "-e", helper], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write("typed\n");
    await child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // Then: the partial prompt and input echo reach the real stdout before the runner's summary.
    expect(code, stderr).toBe(0);
    expect(stdout).toBe('name? typed\n{"exitCode":0,"captured":""}');
    expect(stderr).toContain("to-stderr");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kills a running script promptly when its signal aborts", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-script-abort-"));
  const script = join(root, "sleep.bun.sh");
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  try {
    await writeFile(script, "echo ready; sleep 30; echo finished\n");
    const run = Effect.flatMap(ShellRunner, (shell) =>
      shell.runScript(script, { signal: controller.signal }),
    ).pipe(
      Effect.provide(
        BunShellRunner.layer(() => {
          throw new TypeError("unused interactive IO");
        }),
      ),
      Effect.provideService(StreamFrameSink, {
        emit: (frame) =>
          Effect.sync(() => {
            if (frameText(frame).includes("ready\n")) ready.resolve();
          }),
      }),
    );
    const started = performance.now();
    // When
    const completion = Effect.runPromiseExit(run);
    await Effect.runPromise(Effect.promise(() => ready.promise).pipe(Effect.timeout("2 seconds")));
    controller.abort();
    const exit = await Effect.runPromise(Effect.promise(() => completion).pipe(Effect.timeout("4 seconds")));
    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}, 7000);

test.skipIf(process.platform === "win32").each([
  ["collected", 0],
  ["live", 0],
  ["collected", 3],
  ["live", 3],
] as const)(
  "isolates only lando and removes its launcher in %s mode after exit %i",
  async (mode, exitCode) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-shell-env-'space "));
    const script = join(root, "environment.bun.sh");
    const sh = Bun.which("sh");
    if (sh === null) throw new TypeError("Missing host sh");
    const frames: StreamFrameSinkFrame[] = [];
    const shellLayer = BunShellRunner.layer(() => {
      throw new TypeError("unused interactive IO");
    });
    try {
      await writeFile(
        join(root, "lando"),
        '#!/bin/sh\nprintf "<%s><%s>\\n" "${BUN_BE_BUN-unset}" "${BUN_FEATURE_FLAG_NO_ORPHANS-unset}"\nprintf "%s\\n" "$@"\n',
        { mode: 0o755 },
      );
      await writeFile(
        script,
        `lando "two words" x; sh -c 'printf "[%s]\\n" "$BUN_BE_BUN"'; which lando; echo "$0"; exit ${exitCode}\n`,
      );
      // When
      const result = await Effect.runPromise(
        Effect.flatMap(ShellRunner, (shell) =>
          shell.runScript(script, { cwd: root, env: { PATH: `${root}${delimiter}${dirname(sh)}` } }),
        ).pipe(
          Effect.catchTag("ShellExecError", (error) => Effect.succeed(error)),
          Effect.provide(shellLayer),
          Effect.provide(
            mode === "live"
              ? Layer.succeed(StreamFrameSink, {
                  emit: (frame) =>
                    Effect.sync(() => {
                      frames.push(frame);
                    }),
                })
              : Layer.empty,
          ),
        ),
      );
      // Then
      expect(result.exitCode).toBe(exitCode);
      const stdout = mode === "live" ? frames.map(frameText).join("") : result.stdout;
      if (stdout === undefined) throw new TypeError("Missing script output");
      if (mode === "live") expect(result.stdout).toBe("");
      const lines = stdout.trim().split("\n");
      expect(lines.slice(0, 4)).toEqual(["<unset><unset>", "two words", "x", "[1]"]);
      expect(lines[5]).toBe(script);
      const launcherPath = lines[4];
      if (launcherPath === undefined) throw new TypeError("Missing launcher path");
      expect(dirname(launcherPath)).not.toBe(root);
      expect(await access(dirname(launcherPath)).catch((cause: unknown) => cause)).toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("leaves a supplied stream sink open after script output", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-shell-flush-"));
  const output = createCollectingStreamFrameSink();
  const shellLayer = BunShellRunner.layer(() => {
    throw new TypeError("unused interactive IO");
  });
  try {
    const script = join(root, "flush.bun.sh");
    await writeFile(script, "echo -n abc\n");
    // When
    await Effect.runPromise(
      Effect.flatMap(ShellRunner, (shell) =>
        shell.runScript(script, { cwd: root, env: { PATH: root } }),
      ).pipe(Effect.provide(shellLayer), Effect.provideService(StreamFrameSink, output.sink)),
    );
    // Then
    await Effect.runPromise(output.sink.emit({ kind: "bytes", _tag: "stdout", chunk: "later" }));
    await Effect.runPromise(output.finish());
    expect(output.result().stdout).toBe("abclater");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves PATH unchanged when source mode has no lando delegate", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-shell-no-delegate-"));
  const script = join(root, "path.bun.sh");
  expect(Bun.isStandaloneExecutable).toBe(false);
  expect(Bun.which("lando", { PATH: root, cwd: root })).toBeNull();
  try {
    await writeFile(script, 'echo "$PATH"; echo "$0"\n');
    // When
    const result = await Effect.runPromise(
      Effect.flatMap(ShellRunner, (shell) => shell.runScript(script, { env: { PATH: root } })).pipe(
        Effect.provide(
          BunShellRunner.layer(() => {
            throw new TypeError("unused interactive IO");
          }),
        ),
      ),
    );
    // Then
    expect(result.stdout).toBe(`${root}\n${script}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quotes spaces and apostrophes in a POSIX launcher delegate", () => {
  // Given
  const target = "/tmp/space and 'quote/lando";
  // When
  const launcher = landoLauncher(target, "linux");
  // Then
  expect(launcher).toEqual({
    name: "lando",
    content:
      "#!/bin/sh\nunset BUN_BE_BUN BUN_FEATURE_FLAG_NO_ORPHANS\nexec '/tmp/space and '\\''quote/lando' \"$@\"\n",
  });
});

test("escapes percent signs and uses CRLF in a Windows launcher", () => {
  // Given
  const target = "C:\\Program Files\\%lando%\\lando.exe";
  // When
  const launcher = landoLauncher(target, "win32");
  // Then
  expect(launcher).toEqual({
    name: "lando.cmd",
    content:
      '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "BUN_BE_BUN="\r\nset "BUN_FEATURE_FLAG_NO_ORPHANS="\r\n"C:\\Program Files\\%%lando%%\\lando.exe" %*\r\nexit /b %errorlevel%\r\n',
  });
});

test.each([
  ["collected", undefined],
  ["live", undefined],
  ["collected", "caller-pwd"],
  ["live", "caller-pwd"],
  ["collected", ""],
  ["live", ""],
] as const)(
  "preserves script inputs and both output streams with restricted PATH in %s mode and PWD %j",
  async (mode, pwd) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-shell-runtime-"));
    const frames: StreamFrameSinkFrame[] = [];
    const shellLayer = BunShellRunner.layer(() => {
      throw new TypeError("unused interactive IO");
    });
    try {
      const script = join(root, "probe.bun.sh");
      await writeFile(
        script,
        'echo "$FOO"; echo "<$1>"; echo "<$2>"; echo "<$3>"; pwd; echo "$PWD"; echo diagnostic 1>&2; echo -n tail\n',
      );
      const run = Effect.flatMap(ShellRunner, (shell) =>
        shell.runScript(script, {
          cwd: root,
          env: { PATH: root, FOO: "explicit-env", ...(pwd === undefined ? {} : { PWD: pwd }) },
          argv: ["two words", "", "$(echo injected)"],
        }),
      ).pipe(Effect.provide(shellLayer));
      // When
      const result = await Effect.runPromise(
        mode === "collected"
          ? run
          : run.pipe(
              Effect.provideService(StreamFrameSink, {
                emit: (frame) =>
                  Effect.sync(() => {
                    frames.push(frame);
                  }),
              }),
            ),
      );
      // Then
      const cwd = await realpath(root);
      const expectedStdout = `explicit-env\n<two words>\n<>\n<$(echo injected)>\n${cwd}\n${pwd ?? cwd}\ntail`;
      const expectedStderr = "diagnostic\n";
      if (mode === "collected") {
        expect(result).toEqual({ exitCode: 0, stdout: expectedStdout, stderr: expectedStderr });
      } else {
        expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        expect(
          frames
            .filter((frame) => frame._tag === "stdout")
            .map(frameText)
            .join(""),
        ).toBe(expectedStdout);
        expect(
          frames
            .filter((frame) => frame._tag === "stderr")
            .map(frameText)
            .join(""),
        ).toBe(expectedStderr);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("preserves shell events and redacts scoped tokens in live lines", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-shell-stream-"));
  const secret = "scoped-stream-secret";
  const frames: StreamFrameSinkFrame[] = [];
  const events: LandoEvent[] = [];
  const redaction = makeRedactionService();
  const values = await Effect.runPromise(redaction.payloadValues());
  const payloads = { stdout: createPayloadRedactor(values), stderr: createPayloadRedactor(values) };
  const layer = Layer.mergeAll(
    BunShellRunner.layer(() => {
      throw new TypeError("unused interactive IO");
    }),
    Layer.succeed(
      StreamFrameSink,
      StreamFrameSink.of({
        emit: (frame) =>
          Effect.sync(() => {
            const bytes =
              typeof frame.chunk === "string" ? new TextEncoder().encode(frame.chunk) : frame.chunk;
            frames.push({ ...frame, kind: "bytes", chunk: payloads[frame._tag].write(bytes) });
          }),
      }),
    ),
    Layer.succeed(RedactionService, redaction),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event: LandoEvent) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<never>(),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  try {
    const script = join(root, "probe.bun.sh");
    await writeFile(script, `echo ${secret}; echo ${secret} 1>&2; echo -n ${secret}\n`);
    // When
    const result = await Effect.runPromise(
      BunShellRunner.withShellRedactionTokens(
        [secret],
        Effect.flatMap(ShellRunner, (shell) => shell.runScript(script, { cwd: root })),
      ).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            for (const tag of ["stdout", "stderr"] as const)
              frames.push({ kind: "bytes", _tag: tag, chunk: payloads[tag].flush() });
          }),
        ),
      ),
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const stdout = frames
      .filter((frame) => frame._tag === "stdout")
      .map(frameText)
      .join("");
    const stderr = frames
      .filter((frame) => frame._tag === "stderr")
      .map(frameText)
      .join("");
    expect(stdout).toBe("[redacted]\n[redacted]");
    expect(stderr).toBe("[redacted]\n");
    expect(JSON.stringify(frames)).not.toContain(secret);
    expect(events.map((event) => event._tag)).toEqual(["pre-shell-exec", "post-shell-exec"]);
    expect(JSON.stringify(events)).not.toContain(secret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
