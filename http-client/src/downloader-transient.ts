import type { DownloadFetchError } from "@lando/sdk/errors";

const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export const isTransientDownloadFailure = (error: DownloadFetchError): boolean => {
  switch (error.reason ?? "transport") {
    case "connection-reset":
    case "connection-refused":
    case "timeout":
    case "dns-temporary":
    case "network-unreachable":
      return true;
    case "http-status":
      return error.status !== undefined && TRANSIENT_STATUSES.has(error.status);
    case "host-not-found":
    case "tls-handshake":
    case "trust":
    case "transport":
      return false;
  }
};
