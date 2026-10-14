import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent, ShellRunner } from "@lando/sdk/services";
import { Effect, Exit, Layer, Queue, Stream } from "effect";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";
import { landoLauncher } from "../../src/services/bun-command-env.ts";
import * as BunShellRunner from "../../src/services/shell-runner.ts";

test.each([true, false])(
  "reads inherited piped stdin through EOF when inheritStdin=%s",
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
        shell.runScript(${JSON.stringify(scriptPath)}, { inheritStdin: ${inheritStdin} })
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
            if (frame.chunk === "ready\n") ready.resolve();
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
      const stdout = result.stdout;
      if (stdout === undefined) throw new TypeError("Missing script output");
      const lines = stdout.trim().split("\n");
      expect(lines.slice(0, 4)).toEqual(["<unset><unset>", "two words", "x", "[1]"]);
      expect(lines[5]).toBe(script);
      const launcherPath = lines[4];
      if (launcherPath === undefined) throw new TypeError("Missing launcher path");
      expect(dirname(launcherPath)).not.toBe(root);
      expect(await access(dirname(launcherPath)).catch((cause: unknown) => cause)).toMatchObject({
        code: "ENOENT",
      });
      if (mode === "live") expect(frames.map((frame) => frame.chunk).join("")).toBe(stdout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

test.each(["collected", "live"] as const)(
  "preserves script inputs and both output streams with restricted PATH in %s mode",
  async (mode) => {
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
        'echo "$FOO"; echo "<$1>"; echo "<$2>"; echo "<$3>"; pwd; echo diagnostic 1>&2; echo -n tail\n',
      );
      const run = Effect.flatMap(ShellRunner, (shell) =>
        shell.runScript(script, {
          cwd: root,
          env: { PATH: root, FOO: "explicit-env" },
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
      expect(result).toEqual({
        exitCode: 0,
        stdout: `explicit-env\n<two words>\n<>\n<$(echo injected)>\n${root}\ntail`,
        stderr: "diagnostic\n",
      });
      if (mode === "live") {
        expect(
          frames
            .filter((frame) => frame._tag === "stdout")
            .map((frame) => frame.chunk)
            .join(""),
        ).toBe(result.stdout);
        expect(
          frames
            .filter((frame) => frame._tag === "stderr")
            .map((frame) => frame.chunk)
            .join(""),
        ).toBe(result.stderr);
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
  const layer = Layer.mergeAll(
    BunShellRunner.layer(() => {
      throw new TypeError("unused interactive IO");
    }),
    Layer.succeed(
      StreamFrameSink,
      StreamFrameSink.of({
        emit: (frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
      }),
    ),
    Layer.succeed(
      RedactionService,
      RedactionService.of({
        registerValues: registerRedactionValues,
        forProfile: (profile, options) =>
          Effect.succeed(createRedactor(profile, { values: options?.redactionTokens ?? [] })),
      }),
    ),
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
      ).pipe(Effect.provide(layer)),
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: `${secret}\n${secret}`, stderr: `${secret}\n` });
    expect(frames.map((frame) => frame.chunk)).toEqual(
      expect.arrayContaining(["[redacted]\n", "[redacted]"]),
    );
    expect(JSON.stringify(frames)).not.toContain(secret);
    expect(events.map((event) => event._tag)).toEqual(["pre-shell-exec", "post-shell-exec"]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain("[redacted]");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
