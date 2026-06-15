#!/usr/bin/env bun
import { rewriteScenarioSourceMappedOutput } from "./scenario-source-mapper.ts";

const proc = Bun.spawn({
  cmd: [process.execPath, "test", ...Bun.argv.slice(2)],
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
