import { isIP } from "node:net";
import { Schema } from "effect";
import type { DirectHttpTransport } from "./direct-http.ts";
import { type ResolvedNetworkTrust, fetchInitForNetwork, usesDirectEndpoint } from "./network-trust.ts";
import type { RequestPolicyShape } from "./policy.ts";

export interface HttpTransports {
  readonly fetch: typeof fetch;
  readonly direct: DirectHttpTransport;
}

class RedirectError extends Schema.TaggedError<RedirectError>()("RedirectError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

class ConnectionTargetError extends Schema.TaggedError<ConnectionTargetError>()("ConnectionTargetError", {
  message: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
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
  readonly connectionTarget?: RequestPolicyShape["connectionTarget"];
}

export const requestWithNetworkTrust = async (
  request: NetworkRequest,
  network: RequestNetwork,
  signal: AbortSignal,
): Promise<Response> => {
  let url = new URL(request.url);
  let method = request.method ?? "GET";
  const headers = new Headers(request.headers);
  const target = request.connectionTarget;
  if (target !== undefined) {
    if (
      isIP(target.address) === 0 ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== target.origin ||
      url.username !== "" ||
      url.password !== "" ||
      (headers.has("host") && headers.get("host") !== url.host)
    )
      throw new ConnectionTargetError({
        message: "Invalid connection target or conflicting authority",
        remediation:
          "Provide a connection target whose origin matches the request URL and does not set a conflicting Host header.",
      });
    headers.set("host", url.host);
  }
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
      target !== undefined || (startsDirect && usesDirectEndpoint(url, trust))
        ? await transports.direct(url, {
            method,
            headers,
            signal,
            ca,
            body,
            ...(target === undefined ? {} : { connectionAddress: target.address }),
          })
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
      request.redirect === "manual" ||
      target !== undefined
    ) {
      return response;
    }
    await response.body?.cancel();
    if (request.redirect === "error" || redirects === 20) {
      throw new RedirectError({
        message: request.redirect === "error" ? "redirect forbidden by request policy" : "too many redirects",
        urlOrigin: url.origin,
        remediation:
          request.redirect === "error"
            ? "Set redirect to follow or manual if redirects are expected for this request policy."
            : "Break the redirect loop at the origin or set redirect to manual so the client stops following Location hops.",
      });
    }
    const next = new URL(location, url);
    if (
      (next.protocol !== "http:" && next.protocol !== "https:") ||
      next.username !== "" ||
      next.password !== ""
    ) {
      throw new RedirectError({
        message: "unsupported redirect target",
        urlOrigin: url.origin,
        remediation: "Use an http(s) Location without embedded credentials for redirect targets.",
      });
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
