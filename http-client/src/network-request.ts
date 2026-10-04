import { Schema } from "effect";
import type { DirectHttpTransport } from "./direct-http.ts";
import { type ResolvedNetworkTrust, fetchInitForNetwork, usesDirectEndpoint } from "./network-trust.ts";

export interface HttpTransports {
  readonly fetch: typeof fetch;
  readonly direct: DirectHttpTransport;
}

class RedirectError extends Schema.TaggedError<RedirectError>()("RedirectError", {
  message: Schema.String,
  urlOrigin: Schema.String,
}) {}

interface RequestNetwork {
  readonly transports: HttpTransports;
  readonly trust: ResolvedNetworkTrust | undefined;
  readonly systemCaPems: ReadonlyArray<string>;
}

export interface NetworkRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: RequestInit["body"] | undefined;
  readonly redirect?: "follow" | "manual" | "error";
}

export const requestWithNetworkTrust = async (
  request: NetworkRequest,
  network: RequestNetwork,
  signal: AbortSignal,
): Promise<Response> => {
  let url = new URL(request.url);
  let method = request.method ?? "GET";
  const headers = new Headers(request.headers);
  let body = request.body;
  const { trust, transports, systemCaPems } = network;
  const startsDirect = usesDirectEndpoint(url, trust);
  const ca =
    trust === undefined || (trust.trustHost && trust.caPems.length === 0)
      ? undefined
      : trust.trustHost
        ? [...systemCaPems, ...trust.caPems]
        : trust.caPems;

  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    const response =
      startsDirect && usesDirectEndpoint(url, trust)
        ? await transports.direct(url, { method, headers, signal, ca, body })
        : await transports.fetch(url.href, {
            method,
            headers,
            signal,
            redirect: "manual",
            body,
            ...(trust === undefined ? {} : fetchInitForNetwork(url.href, trust, systemCaPems)),
          });
    const location = response.headers.get("location");
    if (
      ![301, 302, 303, 307, 308].includes(response.status) ||
      location === null ||
      request.redirect === "manual"
    ) {
      return response;
    }
    await response.body?.cancel();
    if (request.redirect === "error" || redirects === 20) {
      throw new RedirectError({
        message: request.redirect === "error" ? "redirect forbidden by request policy" : "too many redirects",
        urlOrigin: url.origin,
      });
    }
    const next = new URL(location, url);
    if (
      (next.protocol !== "http:" && next.protocol !== "https:") ||
      next.username !== "" ||
      next.password !== ""
    ) {
      throw new RedirectError({ message: "unsupported redirect target", urlOrigin: url.origin });
    }
    headers.delete("host");
    headers.delete("proxy-authorization");
    if (url.origin !== next.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("cookie2");
    }
    if (
      ((response.status === 301 || response.status === 302) && method === "POST") ||
      (response.status === 303 && method !== "HEAD" && method !== "GET")
    ) {
      method = "GET";
      body = undefined;
      for (const name of [
        "content-length",
        "content-type",
        "content-encoding",
        "content-language",
        "content-location",
      ]) {
        headers.delete(name);
      }
    }
    url = next;
  }
};
