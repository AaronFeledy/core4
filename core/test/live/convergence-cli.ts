import { Effect } from "effect";

export const runFixtureCli = (
  command: readonly string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.spawn([...command], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      }),
    ),
    (proc) =>
      Effect.promise(async () => {
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      }),
    (proc) =>
      Effect.promise(async () => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        await proc.exited;
      }),
  );
