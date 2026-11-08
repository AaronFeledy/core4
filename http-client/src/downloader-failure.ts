import { DownloadFetchError } from "@lando/sdk/errors";

export interface DownloadSource {
  readonly origin: string;
  readonly filename: string | undefined;
}

export const transportReason = (cause: unknown): Pick<DownloadFetchError, "reason" | "transportCode"> => {
  const code =
    cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  switch (code) {
    case "ECONNRESET":
    case "EPIPE":
    case "ECONNABORTED":
      return { reason: "connection-reset", transportCode: code };
    case "ECONNREFUSED":
      return { reason: "connection-refused", transportCode: code };
    case "ETIMEDOUT":
      return { reason: "timeout", transportCode: code };
    case "EAI_AGAIN":
      return { reason: "dns-temporary", transportCode: code };
    case "ENOTFOUND":
      return { reason: "host-not-found", transportCode: code };
    case "ENETUNREACH":
    case "EHOSTUNREACH":
    case "ENETDOWN":
      return { reason: "network-unreachable", transportCode: code };
    case "EPROTO":
      return { reason: "tls-handshake", transportCode: code };
    default:
      return {
        reason: cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "transport",
        transportCode: code,
      };
  }
};

export const failureObservation = (
  error: Pick<DownloadFetchError, "reason" | "transportCode" | "status">,
): string => {
  const code = error.transportCode === undefined ? "" : ` (${error.transportCode})`;
  switch (error.reason ?? "transport") {
    case "connection-reset":
      return `the connection was reset${code}`;
    case "connection-refused":
      return `the connection was refused${code}`;
    case "timeout":
      return `the download timed out${code}`;
    case "dns-temporary":
      return `DNS resolution temporarily failed${code}`;
    case "host-not-found":
      return `the host could not be resolved${code}`;
    case "network-unreachable":
      return `the network was unreachable${code}`;
    case "tls-handshake":
      return `TLS negotiation failed${code}`;
    case "trust":
      return `TLS trust verification failed${code}`;
    case "http-status":
      return `the origin returned HTTP ${error.status}`;
    case "transport":
      return `the transport failed${code}`;
  }
};

const failureRemediation = (
  source: DownloadSource,
  error: Pick<DownloadFetchError, "reason" | "status">,
): string => {
  switch (error.reason ?? "transport") {
    case "connection-reset":
    case "timeout":
    case "dns-temporary":
    case "network-unreachable":
      return "Check the network, VPN, or proxy (HTTPS_PROXY or network.proxy).";
    case "connection-refused":
    case "host-not-found":
      return `Couldn't reach ${source.origin} or the proxy; check DNS, VPN, and proxy settings (HTTPS_PROXY or network.proxy).`;
    case "tls-handshake":
      return "A proxy or firewall may be intercepting HTTPS; set HTTPS_PROXY or network.proxy if your network requires a proxy.";
    case "http-status":
      if (error.status === 407)
        return "The proxy requires authentication; check HTTPS_PROXY or network.proxy credentials.";
      if (error.status === 404 || error.status === 410)
        return "The file isn't at that URL; check the source URL, update Lando, or report the missing file.";
      if (error.status === 401 || error.status === 403)
        return "The origin refused the download; check proxy or registry credentials.";
      if (error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500))
        return "The origin is having trouble; wait a moment.";
      return `Inspect HTTP status ${error.status} from ${source.origin}; fix the origin response or request.`;
    case "trust":
    case "transport":
      return `Inspect the transport failure for ${source.origin} (DNS, TLS, proxy, or connectivity).`;
  }
};

export const fetchFailure = (
  source: DownloadSource,
  failure: Pick<DownloadFetchError, "reason" | "transportCode" | "status" | "trustCause" | "cause"> & {
    readonly detail?: string;
    readonly remediation?: string;
  },
): DownloadFetchError => {
  const { detail, remediation, ...structured } = failure;
  return new DownloadFetchError({
    ...structured,
    message: `Couldn't download${source.filename === undefined ? "" : ` ${source.filename}`} from ${source.origin}: ${detail?.replace(/[.!?]+$/u, "") ?? failureObservation(failure)}.`,
    urlOrigin: source.origin,
    remediation: remediation ?? failureRemediation(source, failure),
  });
};
