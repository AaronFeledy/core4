import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fixture = join(import.meta.dirname, "fixtures/process-signals.ts");
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
const waitFor = async (root: string, event: string) => {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const found = events(root).find((item) => item.event === event);
    if (found !== undefined) return found;
    await Bun.sleep(10);
  }
  throw new Error(`Missing ${event}: ${JSON.stringify(events(root))}`);
};

const withChild = async (
  mode: string,
  run: (root: string, child: Bun.Subprocess, terminal: Bun.Terminal | undefined) => Promise<void>,
  shell?: "loop" | "ignore" | "nohup" | "background",
  pty = false,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-process-signals-"));
  const terminal = pty ? new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined }) : undefined;
  const cmd =
    shell === "nohup"
      ? ["nohup", process.execPath, fixture, root, mode]
      : shell === undefined
        ? [process.execPath, fixture, root, mode]
        : [
            "bash",
            "-c",
            shell === "background"
              ? '"$1" "$2" "$3" "$4" & wait $!'
              : shell === "ignore"
                ? 'trap "" INT HUP; exec "$1" "$2" "$3" "$4"'
                : 'for n in 1 2; do "$1" "$2" "$3" "$4"; echo CONTINUED >> "$3/continued"; done',
            "signal-fixture",
            process.execPath,
            fixture,
            root,
            mode,
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
    await run(root, child, terminal);
    await Promise.race([
      child.exited,
      Bun.sleep(5000).then(() => {
        throw new Error("Owned child did not settle");
      }),
    ]);
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

const posix = test.skipIf(process.platform === "win32");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  posix(
    `${signal} terminates the owned child by signal after command and runtime finalizers`,
    async () => {
      await withChild("wait", async (root, child) => {
        await waitFor(root, "ready");
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
  "Ctrl-C stops a surrounding shell loop after cleanup in its owned PTY",
  async () => {
    await withChild(
      "wait",
      async (root, child) => {
        await waitFor(root, "ready");
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
      await waitFor(root, "ready");
      child.kill("SIGINT");
      await waitFor(root, "finalizing");
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
        await waitFor(root, "ready");
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
        const ready = (await waitFor(root, "ready")).value;
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
      await waitFor(root, "ready");
      child.kill("SIGTERM");
      await child.exited;
      expect(child.signalCode).toBe("SIGTERM");
      const rendered = events(root).at(-1)?.value;
      if (rendered === undefined || typeof rendered !== "object") throw new Error("Missing rendered output");
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
          const ready = (await waitFor(root, "ready")).value;
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
