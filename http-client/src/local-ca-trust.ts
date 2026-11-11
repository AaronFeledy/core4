import { Context, type Effect } from "effect";

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/u;

/** Loopback, or a host of the app's proxy domain (`lndo.site` by default). */
export const isLocalProbeHost = (hostname: string, domain: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const zone = domain.toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    LOOPBACK_V4.test(host) ||
    host === zone ||
    host.endsWith(`.${zone}`)
  );
};

export interface LocalCaHopTrust {
  /** Set only after a local HTTPS request has read a usable development root. */
  readonly pem: string | undefined;
  readonly isLocalHost: (hostname: string) => boolean;
}

/**
 * Optional source of the active development CA. Absent means public trust
 * behavior is unchanged. `prepare` must not install trust or issue a certificate.
 */
export class LocalCaTrustSource extends Context.Service<
  LocalCaTrustSource,
  {
    /**
     * Domain check is cheap. The root is read only when `hostname` is local,
     * and that read is shared for the rest of the process.
     */
    readonly prepare: (hostname: string) => Effect.Effect<LocalCaHopTrust>;
    readonly trusted: Effect.Effect<boolean>;
  }
>()("@lando/http-client/LocalCaTrustSource") {}
