import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe } from "@lando/sdk/probe";
import { Duration, Effect, Fiber } from "effect";
import { runFixtureCli } from "./convergence-cli.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw cause;
  }
};

test("preserves completed CLI output and nonzero status", async () => {
  const result = await Effect.runPromise(
    runFixtureCli(
      [process.execPath, "-e", 'console.log("stdout"); console.error("stderr"); process.exit(7);'],
      process.cwd(),
    ),
  );
  expect(result).toEqual({ exitCode: 7, stdout: "stdout\n", stderr: "stderr\n" });
});

test.each(["interruption", "deadline"] as const)(
  "reaps the fixture CLI before %s returns, even when the child ignores SIGTERM",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "convergence-cli-cancel-"));
    let pid: number | undefined;
    const child = `process.on("SIGTERM", () => {}); await Bun.write(process.argv.at(-1), String(process.pid)); setInterval(() => {}, 1000);`;
    const effect = runFixtureCli([process.execPath, "-e", child, join(root, "started")], root);
    const invocation: Effect.Effect<unknown, unknown> =
      kind === "deadline"
        ? runProbe({ id: "fixture-cli-deadline", policy: { timeout: Duration.seconds(3) } }, effect)
        : effect;
    const fiber = Effect.runFork(invocation);
    try {
      const startedBy = Date.now() + 2500;
      while (!(await Bun.file(join(root, "started")).exists()) && Date.now() < startedBy) await Bun.sleep(10);
      pid = Number(await readFile(join(root, "started"), "utf8"));
      expect(alive(pid)).toBe(true);
      if (kind === "deadline") {
        const result = await Effect.runPromise(Fiber.join(fiber));
        expect(result).toMatchObject({ outcome: "red", lastError: { _tag: "ProbeTimeoutError" } });
      } else {
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      expect(alive(pid)).toBe(false);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      await Effect.runPromise(Fiber.interrupt(fiber));
      const stoppedBy = Date.now() + 2000;
      while (pid !== undefined && alive(pid) && Date.now() < stoppedBy) await Bun.sleep(10);
      if (pid !== undefined) expect(alive(pid)).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
