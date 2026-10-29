import { ProcessExecError } from "@lando/sdk/errors";
import type { ProcessSpawnOptions, ProcessStreamChunk } from "@lando/sdk/services";

// Private observation is deliberately fixed at 1 MiB per channel, measured before decoding.
const privateCaptureLimit = 1024 * 1024;

export const privateCaptureBudget = (input: ProcessSpawnOptions) => {
  const bytes = { stdout: 0, stderr: 0 };
  return ({ kind, chunk }: ProcessStreamChunk): void => {
    bytes[kind] += chunk.byteLength;
    if (bytes[kind] > privateCaptureLimit) {
      throw new ProcessExecError({
        message: `Private capture exceeded the ${privateCaptureLimit}-byte ${kind} limit.`,
        cmd: input.cmd,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        remediation: "Reduce command output or use ordinary streaming execution instead of private capture.",
      });
    }
  };
};

export const collectPrivateText = async (
  stream: ReadableStream<Uint8Array> | undefined,
  append: (chunk: Uint8Array) => void,
): Promise<string> => {
  if (stream === undefined) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    append(chunk);
    chunks.push(chunk);
  }
  // Decode once, after the byte budget accepts every chunk, preserving split UTF-8 sequences.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.concat(chunks));
};
