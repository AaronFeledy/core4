import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessRunner, type ShellReplInput, ShellRunner } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import { StreamFrameSink } from "../../src/operations/stream-frame-sink.ts";
import { runHostShellRepl } from "../../src/services/host-shell-repl.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import * as BunShellRunner from "../../src/services/shell-runner.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const shellLayer = BunShellRunner.layer(() => {
  throw new TypeError("unused interactive IO");
});

test.skipIf(process.platform === "win32").each(["run", "streamWithExit"] as const)(
  "%s interruption waits for launcher disposal",
  async (mode) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-launcher-interrupt-"));
    const ready = Promise.withResolvers<string>();
    const controller = new AbortController();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        ready.resolve(await request.text());
        return new Response("ready");
      },
    });
    try {
      await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const program = Effect.flatMap(ProcessRunner, (runner) => {
        const input = {
          cmd: process.execPath,
          args: [
            "-e",
            `await fetch(${JSON.stringify(server.url.href)}, { method: "POST", body: Bun.which("lando") }); await Bun.sleep(5000);`,
          ],
          env: { PATH: root },
        };
        return mode === "run"
          ? runner.run(input).pipe(Effect.asVoid)
          : Stream.runDrain(runner.streamWithExit(input));
      }).pipe(Effect.provide(BunProcessRunner.layerWithBunCommandEnv));
      const running = Effect.runPromiseExit(program, { signal: controller.signal });
      const launcher = await Effect.runPromise(
        Effect.promise(() => ready.promise).pipe(Effect.timeout("2 seconds")),
      );
      await access(dirname(launcher));
      // When
      controller.abort();
      const exit = await running;
      // Then
      expect(exit._tag).toBe("Failure");
      await expect(access(dirname(launcher))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each(["collected", "live"] as const)(
  "%s script discovers a relative PATH delegate from the canonical directory",
  async (mode) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-script-context-"));
    let stdout = "";
    try {
      for (const path of ["bin", "physical/bin", "physical/inside"])
        await mkdir(join(root, path), { recursive: true });
      await symlink("physical/inside", join(root, "link"));
      await writeFile(join(root, "bin/lando"), "#!/bin/sh\nprintf wrong\\n\n", { mode: 0o700 });
      await writeFile(join(root, "physical/bin/lando"), "#!/bin/sh\nprintf 'physical-delegate\\n'\n", {
        mode: 0o700,
      });
      await writeFile(join(root, "marker"), "wrong");
      await writeFile(join(root, "physical/marker"), "physical-marker");
      const script = join(root, "probe.bun.sh");
      await writeFile(script, 'lando; pwd; echo "$PWD"; cat marker');
      const cwd = await realpath(join(root, "physical"));
      const run = Effect.flatMap(ShellRunner, (shell) =>
        shell.runScript(script, {
          cwd: `${root}/link/..`,
          env: { PATH: "bin:/usr/bin:/bin" },
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
                    if (frame._tag === "stdout")
                      stdout +=
                        typeof frame.chunk === "string" ? frame.chunk : new TextDecoder().decode(frame.chunk);
                  }),
              }),
            ),
      );
      // Then
      expect(mode === "collected" ? result.stdout : stdout).toBe(
        `physical-delegate\n${cwd}\n${cwd}\nphysical-marker`,
      );
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "interactive execution resolves a moved link separately for each line",
  async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-repl-context-"));
    const firstOutput = Promise.withResolvers<void>();
    let stdout = "";
    try {
      for (const name of ["first", "second"]) {
        await mkdir(join(root, name));
        await writeFile(join(root, name, "marker"), `${name}\n`);
      }
      await symlink("first", join(root, "link"));
      const input: AsyncIterable<ShellReplInput> = (async function* () {
        yield { _tag: "line", line: 'cat marker; pwd; echo "$PWD"' };
        await firstOutput.promise;
        await rm(join(root, "link"));
        await symlink("second", join(root, "link"));
        yield { _tag: "line", line: 'cat marker; pwd; echo "$PWD"' };
        yield { _tag: "eof" };
      })();
      // When
      const result = await Effect.runPromise(
        runHostShellRepl(
          {
            cwd: join(root, "link"),
            resolveSecret: () => Effect.die("unused secret"),
            io: {
              input,
              writeStdout: (chunk) => {
                stdout += chunk;
                if (stdout.includes("first\n")) firstOutput.resolve();
              },
              writeStderr: () => {},
            },
          },
          ownerOnlyFileAccess,
        ),
      );
      // Then
      const canonical = await realpath(root);
      expect(result.exitCode).toBe(0);
      expect(stdout).toBe(
        `first\n${canonical}/first\n${canonical}/first\nsecond\n${canonical}/second\n${canonical}/second\n`,
      );
    } finally {
      firstOutput.resolve();
      await rm(root, { recursive: true, force: true });
    }
  },
);
