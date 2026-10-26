import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fixture = join(import.meta.dirname, "fixtures/process-signals.ts");
type Execution = "source" | "compiled";
let compiledRoot: string | undefined;
let compiled: Promise<string> | undefined;
const compiledFixture = (): Promise<string> => {
  compiled ??= (async () => {
    compiledRoot = await mkdtemp(join(tmpdir(), "lando-compiled-signals-"));
    const binary = join(compiledRoot, "signal-fixture");
    const build = await Bun.build({
      entrypoints: [fixture],
      target: "bun",
      format: "esm",
      bytecode: true,
      compile: { outfile: binary },
    });
    if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"));
    return binary;
  })();
  return compiled;
};
afterAll(async () => {
  if (compiledRoot !== undefined) await rm(compiledRoot, { recursive: true, force: true });
});

interface Recorded {
  readonly event: string;
  readonly value?:
    | {
        readonly pid?: number;
        readonly workingPath?: string;
        readonly raw?: boolean;
        readonly stdout?: string;
        readonly stderr?: string;
      }
    | string
    | boolean;
}
const events = (root: string): Recorded[] => {
  try {
    return readFileSync(join(root, "events"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const waitFor = async (root: string, event: string, child: Bun.Subprocess) => {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const found = events(root).find((item) => item.event === event);
    if (found !== undefined) return found;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await Bun.sleep(10);
  }
  throw new Error(`Missing ${event}: ${JSON.stringify(events(root))}`);
};

const withFixture = async (
  execution: Execution,
  mode: string,
  run: (
    root: string,
    child: Bun.Subprocess,
    terminal: Bun.Terminal | undefined,
    output: Promise<string[]>,
  ) => Promise<void>,
  shell?: "loop" | "ignore" | "nohup" | "background",
  pty = false,
) => {
  const launch = execution === "compiled" ? [await compiledFixture()] : [process.execPath, fixture];
  const root = await mkdtemp(join(tmpdir(), "lando-process-signals-"));
  const terminal = pty ? new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined }) : undefined;
  const cmd =
    shell === "nohup"
      ? ["nohup", ...launch, root, mode]
      : shell === undefined
        ? [...launch, root, mode]
        : [
            "bash",
            "-c",
            `fixtureRoot=$1; fixtureMode=$2; shift 2; ${
              shell === "background"
                ? '"$@" "$fixtureRoot" "$fixtureMode" & wait $!'
                : shell === "ignore"
                  ? 'trap "" INT HUP; exec "$@" "$fixtureRoot" "$fixtureMode"'
                  : 'for n in 1 2; do "$@" "$fixtureRoot" "$fixtureMode"; echo CONTINUED >> "$fixtureRoot/continued"; done'
            }`,
            "signal-fixture",
            root,
            mode,
            ...launch,
          ];
  const child = Bun.spawn({
    cmd,
    detached: shell === "loop" || shell === "background",
    ...(terminal === undefined
      ? { stdin: "ignore" as const, stdout: "pipe" as const, stderr: "pipe" as const }
      : { terminal }),
    env: process.env,
  });
  const output =
    terminal === undefined
      ? Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      : Promise.resolve([]);
  const deadline = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      if (shell === "loop" || shell === "background") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      } else child.kill("SIGKILL");
    }
  }, 10000);
  try {
    await run(root, child, terminal, output);
    await Promise.race([
      child.exited,
      Bun.sleep(5000).then(() => {
        throw new Error("Owned child did not settle");
      }),
    ]);
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const diagnostics = (await output).join("\n");
      if (diagnostics.length > 0)
        throw new Error(`${String(error)}\nOwned fixture: ${diagnostics.slice(-6000)}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      if (shell === "loop" || shell === "background") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      } else child.kill("SIGKILL");
    }
    await child.exited;
    terminal?.close();
    await output;
    await rm(root, { recursive: true, force: true });
  }
};

for (const execution of process.platform === "win32"
  ? (["source"] as const)
  : (["source", "compiled"] as const)) {
  describe(`${execution} signal lifetime`, () => {
    if (execution === "compiled")
      beforeAll(async () => {
        await compiledFixture();
      }, 60_000);
    const withChild = (
      mode: string,
      run: Parameters<typeof withFixture>[2],
      shell?: Parameters<typeof withFixture>[3],
      pty = false,
    ) => withFixture(execution, mode, run, shell, pty);
    const posix = test.skipIf(process.platform === "win32");

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      posix(
        `${signal} terminates the owned child by signal after command and runtime finalizers`,
        async () => {
          await withChild("wait", async (root, child) => {
            await waitFor(root, "ready", child);
            child.kill(signal);
            await child.exited;
            expect(child.signalCode).toBe(signal);
            const recorded = events(root);
            expect(recorded.map((item) => item.event)).toEqual([
              "ready",
              "abort",
              "finalizing",
              "finalized",
              "runtime-finalized",
              "rendered",
            ]);
            expect(recorded.find((item) => item.event === "abort")?.value).toBe(signal);
            expect(recorded.at(-1)?.value).toMatchObject({
              stderr: expect.stringContaining("Cleanup receipt retained"),
            });
          });
        },
        15000,
      );
    }

    posix(
      "SIGINT captured during discovery prevents a later command adapter from launching",
      async () => {
        await withChild("handoff", async (root, child, _terminal, output) => {
          await waitFor(root, "dispatch-ready", child);
          child.kill("SIGINT");
          await waitFor(root, "handoff-captured", child);
          await writeFile(join(root, "continue"), "continue");
          await child.exited;
          expect(child.signalCode).toBe("SIGINT");
          expect(events(root).map((item) => item.event)).toEqual([
            "dispatch-ready",
            "handoff-captured",
            "dispatch-settled",
          ]);
          const [stdout] = await output;
          expect(stdout).toBe("");
        });
      },
      15000,
    );

    for (const mode of ["boot", "boot-cleanup-error"] as const) {
      posix(
        `SIGINT cancels pending runtime acquisition and retains ${mode} finalizers`,
        async () => {
          await withChild(mode, async (root, child) => {
            await waitFor(root, "boot-ready", child);
            child.kill("SIGINT");
            const settled = await Promise.race([
              child.exited.then(() => true),
              Bun.sleep(2000).then(() => false),
            ]);
            expect(settled).toBe(true);
            expect(child.signalCode).toBe("SIGINT");
            expect(events(root).map((item) => item.event)).toEqual([
              "boot-ready",
              "abort",
              "runtime-finalizing",
              "runtime-finalized",
              "rendered",
            ]);
            if (mode === "boot-cleanup-error") {
              const rendered = events(root).at(-1)?.value;
              if (rendered === undefined || typeof rendered !== "object")
                throw new Error("Missing bootstrap failure output");
              expect(rendered.stderr).toContain("Bootstrap cleanup failed [redacted]");
              expect(rendered.stderr).not.toContain("private-signal-token");
            }
          });
        },
        15000,
      );
    }

    posix(
      "Ctrl-C stops a surrounding shell loop after cleanup in its owned PTY",
      async () => {
        await withChild(
          "wait",
          async (root, child) => {
            await waitFor(root, "ready", child);
            process.kill(-child.pid, "SIGINT");
            await child.exited;
            expect(child.signalCode).toBe("SIGINT");
            expect(existsSync(join(root, "continued"))).toBe(false);
            expect(events(root).some((item) => item.event === "rendered")).toBe(true);
          },
          "loop",
          true,
        );
      },
      15000,
    );

    posix(
      "repeated signals during finalization retain the first reason and finish cleanup",
      async () => {
        await withChild("wait", async (root, child) => {
          await waitFor(root, "ready", child);
          child.kill("SIGINT");
          await waitFor(root, "finalizing", child);
          child.kill("SIGTERM");
          child.kill("SIGINT");
          await child.exited;
          expect(child.signalCode).toBe("SIGINT");
          expect(
            events(root)
              .filter((item) => item.event === "abort")
              .map((item) => item.value),
          ).toEqual(["SIGINT"]);
          expect(events(root).at(-1)?.event).toBe("rendered");
        });
      },
      15000,
    );

    posix(
      "background/nohup ignores survive both process signal adapters",
      async () => {
        await withChild(
          "ignored",
          async (root, child) => {
            await waitFor(root, "ready", child);
            child.kill("SIGHUP");
            child.kill("SIGINT");
            await child.exited;
            expect(child.signalCode).toBeNull();
            expect(child.exitCode).toBe(7);
            expect(events(root).some((item) => item.event === "abort")).toBe(false);
            expect(events(root).at(-1)?.value).toMatchObject({ stdout: "completed\n" });
          },
          "ignore",
        );
      },
      15000,
    );

    posix(
      "compressed import cancellation removes staging and restores actual owned PTY flags",
      async () => {
        await withChild(
          "compressed",
          async (root, child, terminal) => {
            if (terminal === undefined) throw new Error("Missing owned PTY");
            const before = {
              input: terminal.inputFlags,
              local: terminal.localFlags,
              output: terminal.outputFlags,
              control: terminal.controlFlags,
            };
            const ready = (await waitFor(root, "ready", child)).value;
            if (ready === undefined || typeof ready !== "object" || ready.workingPath === undefined)
              throw new Error("Missing staging path");
            expect(ready.raw).toBe(true);
            expect(existsSync(ready.workingPath)).toBe(true);
            expect(terminal.localFlags).not.toBe(before.local);
            child.kill("SIGINT");
            await child.exited;
            expect(child.signalCode).toBe("SIGINT");
            expect(existsSync(dirname(ready.workingPath))).toBe(false);
            expect(events(root).find((item) => item.event === "raw-restored")?.value).toBe(false);
            expect({
              input: terminal.inputFlags,
              local: terminal.localFlags,
              output: terminal.outputFlags,
              control: terminal.controlFlags,
            }).toEqual(before);
          },
          undefined,
          true,
        );
      },
      15000,
    );

    posix(
      "abort retains redacted cleanup failures and receipts before re-raising",
      async () => {
        await withChild("cleanup-error", async (root, child) => {
          await waitFor(root, "ready", child);
          child.kill("SIGTERM");
          await child.exited;
          expect(child.signalCode).toBe("SIGTERM");
          const rendered = events(root).at(-1)?.value;
          if (rendered === undefined || typeof rendered !== "object")
            throw new Error("Missing rendered output");
          expect(rendered.stderr).toContain("Cleanup failed [redacted]");
          expect(rendered.stderr).toContain("Cleanup receipt retained");
          expect(JSON.stringify(rendered)).not.toContain("private-signal-token");
        });
      },
      15000,
    );

    test("normal completion keeps the command completion exit code", async () => {
      await withChild("complete", async (root, child) => {
        await child.exited;
        expect(child.signalCode).toBeNull();
        expect(child.exitCode).toBe(7);
        expect(events(root).at(-1)?.value).toMatchObject({ stdout: "completed\n" });
      });
    }, 15000);

    for (const [shell, signal] of [
      ["nohup", "SIGHUP"],
      ["background", "SIGINT"],
    ] as const) {
      posix(
        `${shell} keeps its inherited ${signal} ignore`,
        async () => {
          await withChild(
            "ignored",
            async (root, child) => {
              const ready = (await waitFor(root, "ready", child)).value;
              if (ready === undefined || typeof ready !== "object" || ready.pid === undefined)
                throw new Error("Missing owned child pid");
              process.kill(ready.pid, signal);
              await child.exited;
              expect(child.signalCode).toBeNull();
              expect(child.exitCode).toBe(7);
              expect(events(root).some((item) => item.event === "abort")).toBe(false);
              expect(events(root).at(-1)?.value).toMatchObject({ stdout: "completed\n" });
            },
            shell,
          );
        },
        15000,
      );
    }

    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      test.skipIf(process.platform !== "win32")(
        `Windows ${signal} preserves exit ${code} after finalizers`,
        async () => {
          await withChild(`windows-${signal}`, async (root, child) => {
            await child.exited;
            expect(child.signalCode).toBeNull();
            expect(child.exitCode).toBe(code);
            expect(events(root).at(-1)?.event).toBe("rendered");
            expect(events(root).find((item) => item.event === "abort")?.value).toBe(signal);
          });
        },
        15000,
      );
    }
  });
}
