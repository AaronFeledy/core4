import type { StreamFrameSinkShape } from "@lando/engine/operations/stream-frame-sink";
import { ProcessExecError } from "@lando/sdk/errors";
import type { CommandOutput } from "@lando/sdk/schema";
import { Context, Effect } from "effect";

export interface ChildOutputPolicy {
  readonly native: boolean;
  readonly stdin: boolean;
  readonly stream:
    | (() => Effect.Effect<
        { readonly sink: StreamFrameSinkShape; readonly finish: () => Effect.Effect<void> },
        never,
        import("@lando/redaction/service").RedactionService | import("@lando/sdk/services").Renderer
      >)
    | undefined;
  readonly append: (
    cmd: string,
    raw: { readonly stdout: string; readonly stderr: string },
    output: { readonly stdout: string; readonly stderr: string },
  ) => Effect.Effect<void, ProcessExecError>;
  readonly output: () => CommandOutput | undefined;
}

export const ChildOutput = Context.Reference<ChildOutputPolicy | undefined>("@lando/core/ChildOutput", {
  defaultValue: () => undefined,
});

export const makeChildOutputPolicy = (
  authorization: Pick<ChildOutputPolicy, "native" | "stdin" | "stream">,
): ChildOutputPolicy => {
  const chunks: Array<CommandOutput["chunks"][number]> = [];
  const bytes = { stdout: 0, stderr: 0 };
  return {
    ...authorization,
    append: (cmd, raw, output) =>
      Effect.suspend(() => {
        const sizes = {
          stdout: Math.max(Buffer.byteLength(raw.stdout), Buffer.byteLength(output.stdout)),
          stderr: Math.max(Buffer.byteLength(raw.stderr), Buffer.byteLength(output.stderr)),
        };
        for (const kind of ["stdout", "stderr"] as const) {
          if (bytes[kind] + sizes[kind] > 1024 * 1024)
            return Effect.fail(
              new ProcessExecError({
                cmd,
                message: `Invocation output exceeded the 1048576-byte ${kind} limit.`,
                remediation: "Reduce child output before retrying this command.",
              }),
            );
        }
        for (const kind of ["stdout", "stderr"] as const) {
          bytes[kind] += sizes[kind];
          if (output[kind] !== "") chunks.push({ _tag: kind, chunk: output[kind] });
        }
        return Effect.void;
      }),
    output: () => (chunks.length === 0 ? undefined : { chunks: [...chunks], truncated: false }),
  };
};
