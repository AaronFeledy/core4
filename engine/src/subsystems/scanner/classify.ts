import type { Redactor } from "@lando/sdk/secrets";
import type { ScanVerdict } from "@lando/sdk/services";

export type AttemptStatus =
  | {
      readonly _tag: "response";
      readonly status: number;
      readonly routerMarker?: string;
      readonly location?: string;
    }
  | { readonly _tag: "transport"; readonly message: string; readonly refused?: boolean }
  | { readonly _tag: "timeout" };

export interface ScanClassification {
  readonly verdict: ScanVerdict;
  readonly detail?: string;
}

const redirect = (
  status: number,
  location: string,
  context: { url: string; redactor: Redactor },
): ScanClassification => {
  if (location.trim() === "") return { verdict: "app-error" };
  const from = URL.parse(context.url);
  if (from === null) return { verdict: "app-error" };
  const to = URL.parse(location, from.href);
  if (to === null) return { verdict: "app-error" };
  if (to.protocol !== "http:" && to.protocol !== "https:") {
    return { verdict: "app-error", detail: `${status} redirects to a non-HTTP URL` };
  }
  if (to.origin === from.origin) {
    const path = context.redactor.redactString(`${to.pathname}${to.search}${to.hash}`);
    return { verdict: "ready", detail: `${status} → ${path}` };
  }
  const target = context.redactor.redactString(to.href);
  if (to.hostname !== from.hostname) {
    return { verdict: "app-error", detail: `${status} redirects to another host: ${target}` };
  }
  const effectivePort = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");
  const difference =
    to.protocol === from.protocol
      ? "port"
      : effectivePort(to) === effectivePort(from)
        ? "scheme"
        : "scheme and port";
  const origin = context.redactor.redactString(from.origin);
  return {
    verdict: "app-error",
    detail: `${status} redirects to ${target} with a different ${difference}; configure your app's base URL to match ${origin}`,
  };
};

export const classify = (
  observation: AttemptStatus,
  okCodes: readonly number[],
  context: { readonly url: string; readonly idlePort?: number; readonly redactor: Redactor },
): ScanClassification => {
  const { idlePort } = context;
  const expected = (): ScanClassification => ({
    verdict: "expected",
    detail: `nothing is listening on port ${idlePort} yet; start your server or set \`command:\` in your Landofile`,
  });
  switch (observation._tag) {
    case "transport": {
      const host = URL.parse(context.url)?.hostname;
      return idlePort !== undefined &&
        observation.refused &&
        (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
        ? expected()
        : { verdict: "lando-error" };
    }
    case "timeout":
      return { verdict: "lando-error" };
    case "response": {
      const { status, routerMarker, location } = observation;
      if (routerMarker === undefined && okCodes.includes(status)) return { verdict: "ready" };
      const gateway = status === 502 || status === 504;
      if (
        idlePort !== undefined &&
        (routerMarker === "upstream-unreachable" || (gateway && routerMarker === undefined))
      ) {
        return expected();
      }
      if (routerMarker !== undefined) return { verdict: "lando-error" };
      if (status >= 200 && status < 300) return { verdict: "ready" };
      if (status >= 300 && status < 400 && location !== undefined) return redirect(status, location, context);
      // A 503 can be maintenance mode; only gateway statuses are service-owned.
      return { verdict: gateway ? "service-error" : "app-error" };
    }
  }
};
