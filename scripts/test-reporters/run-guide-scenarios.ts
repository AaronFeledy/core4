#!/usr/bin/env bun
import { rewriteScenarioSourceMappedOutput } from "./scenario-source-mapper.ts";

export const guideScenarioTestArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.some((arg) => arg === "--max-concurrency" || arg.startsWith("--max-concurrency="))
    ? args
    : [...args, "--max-concurrency=1"];

const main = async (): Promise<never> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", ...guideScenarioTestArgs(Bun.argv.slice(2))],
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  process.stdout.write(rewriteScenarioSourceMappedOutput(`${stdout}${stderr}`));
  process.exit(exitCode);
};

if (import.meta.main) await main();
