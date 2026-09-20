#!/usr/bin/env bun
import { rewriteScenarioSourceMappedOutput } from "./scenario-source-mapper.ts";

export const LIVE_OUTPUT_ENV = "LANDO_GUIDE_SCENARIO_LIVE_OUTPUT";
export const LIVE_OUTPUT_BANNER =
  "==> guide scenarios: live unmapped bun test output follows (LANDO_GUIDE_SCENARIO_LIVE_OUTPUT=1); the source-mapped document is printed again after the child exits";
export const MAPPED_OUTPUT_BANNER =
  "==> guide scenarios: source-mapped document (authoritative; repeats the live output above)";

export const liveOutputEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[LIVE_OUTPUT_ENV] === "1";

// Response.text() owns the buffered read: a hand-rolled getReader() loop over a
// subprocess stream intermittently drops trailing bytes. Live callers get their
// own tee() branch so teeing never touches the authoritative buffer.
export const drainStream = async (
  stream: ReadableStream<Uint8Array>,
  tee: ((chunk: Uint8Array) => void) | null,
): Promise<string> => {
  if (tee === null) return new Response(stream).text();
  const [live, buffered] = stream.tee();
  const pump = (async (): Promise<void> => {
    const reader = live.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tee(value);
    }
  })();
  const [text] = await Promise.all([new Response(buffered).text(), pump]);
  return text;
};

export const guideScenarioTestArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.some((arg) => arg === "--max-concurrency" || arg.startsWith("--max-concurrency="))
    ? args
    : [...args, "--max-concurrency=1"];

const main = async (): Promise<never> => {
  const live = liveOutputEnabled(process.env);
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", ...guideScenarioTestArgs(Bun.argv.slice(2))],
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (live) process.stdout.write(`${LIVE_OUTPUT_BANNER}\n`);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    drainStream(
      proc.stdout,
      live
        ? (chunk) => {
            process.stdout.write(chunk);
          }
        : null,
    ),
    drainStream(
      proc.stderr,
      live
        ? (chunk) => {
            process.stderr.write(chunk);
          }
        : null,
    ),
  ]);

  if (live) process.stdout.write(`${MAPPED_OUTPUT_BANNER}\n`);
  process.stdout.write(rewriteScenarioSourceMappedOutput(`${stdout}${stderr}`));
  // Bun's empty-write callback can precede flushing; end both streams before exiting.
  await Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.end(resolve))),
  );
  process.exit(exitCode);
};

if (import.meta.main) await main();
