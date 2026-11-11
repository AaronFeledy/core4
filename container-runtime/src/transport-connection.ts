import type {
  Bytes,
  ConnectableSocket,
  SocketHttpClientOptions,
  SocketHttpConnection,
  SocketHttpRequest,
} from "./transport.ts";
import { ContainerTransportError, type SocketReadSystemCode } from "./transport-error.ts";
import { fail } from "./transport-http.ts";

const SOCKET_READ_SYSTEM_CODES = ["ECONNABORTED", "ECONNRESET", "EPIPE", "ETIMEDOUT"] as const;

export const connectSocket = async (socket: ConnectableSocket, signal?: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (cause: Error) => {
      cleanup();
      socket.destroy();
      reject(cause);
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(new DOMException("Socket connection aborted.", "AbortError"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const socketReadSystemCode = (cause: unknown): SocketReadSystemCode | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = Reflect.get(cause, "code");
  return typeof code === "string"
    ? SOCKET_READ_SYSTEM_CODES.find((candidate) => candidate === code)
    : undefined;
};

export async function* readResponse(
  connection: SocketHttpConnection,
  operation: string,
  request: SocketHttpRequest,
): AsyncGenerator<Bytes> {
  try {
    yield* connection;
  } catch (cause) {
    if (cause instanceof ContainerTransportError || request.signal?.aborted === true) throw cause;
    const systemCode = socketReadSystemCode(cause);
    throw new ContainerTransportError({
      kind: "read",
      operation,
      message: "Failed to read the container runtime HTTP response.",
      details: { method: request.method, path: request.path },
      ...(systemCode === undefined ? {} : { systemCode }),
      cause,
    });
  }
}

export const connect = async (
  options: SocketHttpClientOptions,
  request: SocketHttpRequest,
): Promise<SocketHttpConnection> => {
  try {
    return await options.connect(request.signal);
  } catch (cause) {
    throw fail(
      "connect",
      options.operation ?? "container-transport",
      "Failed to connect to the container runtime socket.",
      { method: request.method, path: request.path },
      cause,
    );
  }
};
