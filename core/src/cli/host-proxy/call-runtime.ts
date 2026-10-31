import { Schema } from "effect";
import { HostProxyCall } from "./call-context";

export const runHostProxyCallProcess = async (
  dispatch: (call: HostProxyCall, signal: AbortSignal) => Promise<void>,
): Promise<void> => {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  let line = "";
  try {
    while (!line.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new TypeError("Invalid host-proxy call input.");
      line += decoder.decode(next.value, { stream: true });
      if (line.length > 1024 * 1024) throw new TypeError("Invalid host-proxy call input.");
    }
    const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(HostProxyCall))(
      line.slice(0, line.indexOf("\n")),
    );
    if (decoded._tag === "Failure") throw new TypeError("Invalid host-proxy call input.");
    const call = decoded.success;
    let finished = false;
    const lease = (async () => {
      if (!(await reader.read()).done) {
        controller.abort();
        return;
      }
      if (!finished) controller.abort();
    })();
    void lease.catch(() => controller.abort());
    try {
      await dispatch(call, controller.signal);
    } finally {
      finished = true;
    }
  } finally {
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
    await reader.cancel();
    reader.releaseLock();
  }
};
