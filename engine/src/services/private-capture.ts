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
  stop?: AbortSignal,
): Promise<string> => {
  if (stream === undefined) return "";
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  // A killed child's descendants can keep the pipe open; stopping cancels the read instead of waiting for them.
  let cancelFailure: unknown;
  const cancel = () => {
    reader.cancel(stop?.reason).then(undefined, (cause: unknown) => {
      cancelFailure = cause;
    });
  };
  if (stop?.aborted) cancel();
  else stop?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      append(next.value);
      chunks.push(next.value);
    }
  } catch (cause) {
    cancel();
    throw cause;
  } finally {
    stop?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (cancelFailure !== undefined) throw cancelFailure;
  // Decode once, after the byte budget accepts every chunk, preserving split UTF-8 sequences.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.concat(chunks));
};
