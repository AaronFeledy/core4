import type { Bytes, SocketHttpClientOptions, SocketHttpConnection, SocketHttpRequest } from "./transport.ts";
import { fail, textEncoder } from "./transport-http.ts";

const requestBody = (request: SocketHttpRequest): string | undefined =>
  request.body === undefined ? undefined : JSON.stringify(request.body);

export const socketHttpRequestText = (
  request: SocketHttpRequest,
  options: Pick<SocketHttpClientOptions, "apiPrefix" | "hostHeader" | "defaultHeaders">,
  body = requestBody(request),
  rawBodyLength?: number,
): string => {
  const explicitConnection = Object.keys(request.headers ?? {}).some(
    (key) => key.toLowerCase() === "connection",
  );
  const headers = [
    `${request.method} ${options.apiPrefix}${request.path} HTTP/1.1`,
    `Host: ${options.hostHeader ?? "localhost"}`,
    ...(explicitConnection ? [] : ["Connection: close"]),
    ...Object.entries(options.defaultHeaders ?? {}).map(([key, value]) => `${key}: ${value}`),
    ...Object.entries(request.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
  ];
  if (body !== undefined) {
    headers.push("Content-Type: application/json", `Content-Length: ${textEncoder.encode(body).length}`);
  } else if (rawBodyLength !== undefined) {
    headers.push(`Content-Length: ${rawBodyLength}`);
  }
  return `${headers.join("\r\n")}\r\n\r\n${body ?? ""}`;
};

export const writeRequest = async (
  connection: SocketHttpConnection,
  request: SocketHttpRequest,
  options: SocketHttpClientOptions,
  stdinPayload?: Bytes,
): Promise<void> => {
  try {
    await connection.write(
      socketHttpRequestText(
        request,
        options,
        stdinPayload === undefined ? requestBody(request) : undefined,
        stdinPayload?.length,
      ),
    );
    if (stdinPayload !== undefined) await connection.write(stdinPayload);
  } catch (cause) {
    throw fail(
      "write",
      options.operation ?? "container-transport",
      "Failed to write the container runtime HTTP request.",
      { method: request.method, path: request.path },
      cause,
    );
  }
};
