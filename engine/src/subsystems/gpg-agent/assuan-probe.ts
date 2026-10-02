import { connect } from "node:net";

export type GpgAgentRestriction = "restricted" | "unrestricted";

const MAX_REPLY_BYTES = 4 * 1024;
const isAnswer = (line: string) => line.startsWith("OK") || line.startsWith("ERR");

/**
 * Asks a gpg-agent socket whether it is the restricted extra socket. Assuan is
 * line based: the agent greets with an `OK` line, `GETINFO restricted` answers
 * `OK` only on the restricted socket, and comment (`#`) or status (`S`) lines
 * may appear before either answer.
 */
export const probeRestrictedGpgAgent = (
  path: string,
  options: { readonly timeoutMs: number },
): Promise<GpgAgentRestriction> =>
  new Promise((resolve, reject) => {
    const socket = connect({ path });
    let buffered = "";
    let greeted = false;
    let settled = false;
    const finish = (outcome: GpgAgentRestriction | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timeout = setTimeout(
      () => finish(new Error("The gpg-agent restricted probe timed out.")),
      options.timeoutMs,
    );
    socket.once("error", (cause) => finish(new Error("The gpg-agent socket refused the probe.", { cause })));
    socket.once("close", () => finish(new Error("The gpg-agent socket closed before answering the probe.")));
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (buffered.length > MAX_REPLY_BYTES) {
        finish(new Error("The gpg-agent reply exceeded the probe limit."));
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline !== -1 && !settled) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!isAnswer(line)) continue;
        if (!greeted) {
          if (!line.startsWith("OK")) {
            finish(new Error("The gpg-agent did not greet the probe."));
            return;
          }
          greeted = true;
          socket.write("GETINFO restricted\n");
          continue;
        }
        finish(line.startsWith("OK") ? "restricted" : "unrestricted");
      }
    });
  });
