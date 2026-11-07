import { resolveProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { DEFAULT_PROXY_DOMAIN } from "@lando/engine/planner/naming";
import { Duration, Effect, Ref, Result } from "effect";

import { runProbe } from "@lando/sdk/probe";

import { HostDnsResolver } from "./doctor-host-dns";
import { type DoctorSubsystemCheck, HOST_DNS_SPEC, passCheck } from "./doctor-subsystem-checks";

export const HOST_DNS_LOOPBACK = "127.0.0.1";

export const buildHostDnsCheck = Effect.fnUntraced(function* (
  fix: boolean,
): Effect.fn.Return<DoctorSubsystemCheck, never, HostDnsResolver> {
  const baseDomain = (yield* resolveProxyDefaultDomain).toLowerCase();
  const loopback = HOST_DNS_LOOPBACK;
  const resolver = yield* HostDnsResolver;
  const hostname = `lando-doctor-probe.${baseDomain}`;
  const addressesRef = yield* Ref.make<ReadonlyArray<string>>([]);
  const resolved = yield* Effect.result(
    runProbe(
      {
        id: "doctor.host-dns",
        policy: { maxAttempts: 1, timeout: Duration.millis(1500) },
        classify: {
          success: (value) => (value === true ? "green" : "red"),
          failure: () => "red",
        },
      },
      resolver.lookup(hostname).pipe(
        Effect.tap((addresses) => Ref.set(addressesRef, addresses)),
        Effect.map((addresses) => addresses.length > 0 && addresses.every((address) => address === loopback)),
      ),
    ),
  );
  const addresses = yield* Ref.get(addressesRef);
  const dnsReady = Result.isSuccess(resolved) && resolved.success.outcome === "green";
  const dnsContext: Record<string, string> = {
    subsystem: "host-dns",
    baseDomain,
    loopback,
    dnsHostname: hostname,
    dnsResolved: String(dnsReady),
    ...(addresses.length === 0 ? {} : { dnsAddresses: addresses.join(",") }),
  };
  if (dnsReady) return passCheck(HOST_DNS_SPEC, dnsContext);

  const cause =
    baseDomain === DEFAULT_PROXY_DOMAIN
      ? `${baseDomain} relies on public DNS, which fails offline or behind a resolver that drops loopback answers (DNS-rebinding protection).`
      : `Lando does not configure DNS for ${baseDomain}.`;
  const manualRemediation = `Host DNS does not resolve ${hostname} to ${loopback}. ${cause} Add a local DNS rule (dnsmasq or your OS resolver) that resolves *.${baseDomain} to ${loopback}, then run \`lando doctor\` again.`;
  return {
    name: HOST_DNS_SPEC.name,
    status: "warn",
    severity: "warn",
    recovery: "manual",
    context: {
      ...dnsContext,
      ...(fix ? { fixOutcome: "skipped-manual" } : {}),
    },
    solutions: [{ kind: "manual", description: manualRemediation }],
  };
});
