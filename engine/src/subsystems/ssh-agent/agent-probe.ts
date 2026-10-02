import { type AgentRelayUpstream, agentTransportError, connectAgentUpstream } from "./relay.ts";

export const probeSshAgent = (
  upstream: AgentRelayUpstream,
  options: { readonly timeoutMs: number },
): Promise<{ readonly identities: number }> =>
  new Promise((resolve, reject) => {
    const socket = connectAgentUpstream(upstream);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(
      () => finish(agentTransportError("SSH agent identity request timed out.")),
      options.timeoutMs,
    );
    const finish = (error?: Error, identities = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve({ identities });
    };
    socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 1, 11])));
    socket.once("error", (cause) => finish(agentTransportError("SSH agent identity request failed.", cause)));
    socket.once("close", () =>
      finish(agentTransportError("SSH agent closed before answering the identity request.")),
    );
    socket.on("data", (chunk: Buffer) => {
      if (bytes.length + chunk.length > 1024 * 1024) {
        finish(agentTransportError("SSH agent response exceeds the frame limit."));
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (length < 5 || length > 1024 * 1024 - 4) {
        finish(agentTransportError("SSH agent returned an invalid frame length."));
        return;
      }
      if (bytes.length < length + 4) return;
      if (bytes[4] !== 12) {
        finish(agentTransportError("SSH agent did not return identities."));
        return;
      }
      const count = bytes.readUInt32BE(5);
      let offset = 9;
      for (let field = 0; field < count * 2; field++) {
        if (offset + 4 > length + 4) {
          finish(agentTransportError("SSH agent returned truncated identities."));
          return;
        }
        const size = bytes.readUInt32BE(offset);
        offset += 4 + size;
        if (offset > length + 4) {
          finish(agentTransportError("SSH agent returned truncated identities."));
          return;
        }
      }
      if (offset !== length + 4) {
        finish(agentTransportError("SSH agent returned extra identity data."));
        return;
      }
      finish(undefined, count);
    });
  });
