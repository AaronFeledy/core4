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
