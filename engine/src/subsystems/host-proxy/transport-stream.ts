import type { ServerResponse } from "node:http";

export const writeHostProxyFrame = async (response: ServerResponse, frame: unknown): Promise<void> => {
  if (response.destroyed || response.writableEnded) throw new TypeError("Host-proxy caller disconnected.");
  if (!response.headersSent) response.writeHead(200, { "content-type": "application/x-ndjson" });
  if (response.write(`${JSON.stringify(frame)}\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new TypeError("Host-proxy caller disconnected."));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
    if (response.destroyed) closed();
  });
};
