import wasmUrl from "jq-wasm/jq.wasm" with { type: "file" };

import type { JqEngine } from "./types.ts";

// Sidecar wasm via Bun file import; bun test resolves jq-wasm/jq.wasm.

type LoadedJq = Awaited<ReturnType<typeof import("jq-wasm")["loadJq"]>>;

let jqHandle: Promise<LoadedJq> | undefined;

const loadJqCached = (): Promise<LoadedJq> => {
  jqHandle ??= import("jq-wasm").then(({ loadJq }) => loadJq({ wasmURL: wasmUrl }));
  return jqHandle;
};

const jsonTextForJq = (input: unknown): string => {
  const payload = JSON.stringify(input);
  if (typeof payload === "string") {
    return payload;
  }
  throw new Error("jq input is not JSON-serializable");
};

// jq-wasm exposes no abort entry point (`raw(input, query, flags?)` is the whole
// API), so the caller's AbortSignal cannot cancel an in-flight evaluation. The
// timeout in eval.ts still returns control at the deadline and swallows late
// settlement; until jq-wasm grows a cancellation hook, worst case is wasted CPU
// on an already-timed-out expression.
export const jqWasmEngine: JqEngine = {
  async eval(input, expr) {
    const jq = await loadJqCached();
    const result = jq.raw(jsonTextForJq(input), expr, ["-c"]);
    if (result.exitCode === 0) {
      return { text: result.stdout };
    }
    const detail = result.stderr.trim();
    throw new Error(detail === "" ? `jq exited ${result.exitCode}` : detail);
  },
};
