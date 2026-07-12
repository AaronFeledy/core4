import { ProviderInternalError } from "@lando/sdk/errors";
import type { ProviderError } from "@lando/sdk/services";

import { type StreamBytes, makeAttachDecoder } from "./streams.ts";

type OutputMode = "unknown" | "raw" | "framed";

export type HelperExecOutput =
  | { readonly kind: "stdout"; readonly payload: StreamBytes }
  | { readonly kind: "error"; readonly error: ProviderError };

const decoder = new TextDecoder();

const stderrFrameError = (providerId: string, payload: StreamBytes): ProviderInternalError =>
  new ProviderInternalError({
    providerId,
    operation: "logFileAccess",
    message: "Log helper wrote to stderr.",
    details: decoder.decode(payload),
  });

export const makeHelperExecOutputDecoder = (providerId: string) => {
  const decodeAttach = makeAttachDecoder();
  let mode: OutputMode = "unknown";

  return (chunk: StreamBytes): ReadonlyArray<HelperExecOutput> => {
    if (chunk.length === 0) return [];
    if (mode === "raw") return [{ kind: "stdout", payload: chunk }];
    if (mode === "unknown") mode = chunk[0] === 1 || chunk[0] === 2 ? "framed" : "raw";
    if (mode === "raw") return [{ kind: "stdout", payload: chunk }];

    return decodeAttach(chunk).map((frame) =>
      frame.stream === "stdout"
        ? { kind: "stdout", payload: frame.payload }
        : { kind: "error", error: stderrFrameError(providerId, frame.payload) },
    );
  };
};
