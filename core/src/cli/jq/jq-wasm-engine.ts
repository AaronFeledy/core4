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
// API) and its evaluation is synchronous once started, so the caller's
// AbortSignal cannot interrupt an in-flight expression; the eval.ts deadline
// resolves at the next await boundary and swallows late settlement. Running the
// evaluator in a Worker was tried and rejected: bun build --compile does not
// embed module workers referenced by URL (the compile smoke fails), so real
// cancellation needs a sidecar process or an upstream jq-wasm cancel hook.
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
