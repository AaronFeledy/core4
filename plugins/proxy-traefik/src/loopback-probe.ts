import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";

type TcpProbeResult = "refused" | "open" | "unknown";

export const probeTcp = ({
  host = "127.0.0.1",
  port,
  timeoutMs,
}: {
  readonly host?: string;
  readonly port: number;
  readonly timeoutMs: number;
}): Promise<TcpProbeResult> =>
  new Promise((resolve) => {
    const socket = new Socket();
    const finish = (result: TcpProbeResult) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("unknown"));
    socket.once("error", (error: Error) => {
      const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
      finish(code === "ECONNREFUSED" ? "refused" : "unknown");
    });
    socket.connect(port, host);
  });

export const probeHttp = ({
  host = "127.0.0.1",
  port,
  role,
  timeoutMs,
}: {
  readonly host?: string;
  readonly port: number;
  readonly role: "http" | "https";
  readonly timeoutMs: number;
}): Promise<boolean> =>
  new Promise((resolve) => {
    const request = (role === "https" ? https : http).request(
      { host, port, path: "/", method: "GET", timeout: timeoutMs, rejectUnauthorized: false },
      (response) => {
        response.resume();
        resolve(response.statusCode !== undefined);
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
    request.end();
  });
