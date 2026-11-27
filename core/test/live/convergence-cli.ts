import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

export const decodeInfoCliEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(CommandResultEnvelope), {
  onExcessProperty: "error",
});

const decodeStreamFrame = Schema.decodeUnknownSync(Schema.fromJsonString(StreamFrame), {
  onExcessProperty: "error",
});

/** The envelope of a live command's `--format=json` output: the terminal `result` frame, its last line. */
export const decodeResultFrameEnvelope = (text: string): CommandResultEnvelope => {
  const frame = decodeStreamFrame(text.trimEnd().split("\n").at(-1) ?? "");
  if (frame._tag !== "result") throw new Error(`The last frame is ${frame._tag}, not result:\n${text}`);
  return frame.envelope;
};

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
