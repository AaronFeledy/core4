import { Schema } from "effect";
import { type ResolvedNetworkTrust, fetchInitForNetwork, shouldBypassProxy } from "./network-trust.ts";

export interface HttpTransports {
  readonly fetch: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>;
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

  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    const init =
      trust === undefined
        ? shouldBypassProxy(url.href, [])
          ? { proxy: false as const }
          : {}
        : fetchInitForNetwork(url.href, trust, systemCaPems);
    const response = await transports.fetch(url.href, {
      method,
      headers,
      signal,
      redirect: "manual",
      body,
      ...init,
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
