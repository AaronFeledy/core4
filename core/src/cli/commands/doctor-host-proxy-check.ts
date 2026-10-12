import { resolveProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { DEFAULT_PROXY_DOMAIN } from "@lando/engine/planner/naming";
import { Duration, Effect, Ref, Result } from "effect";

import { runProbe } from "@lando/sdk/probe";
import type { HostProxyService } from "@lando/sdk/services";

import { HostDnsResolver } from "./doctor-host-dns";
import {
  type DoctorSubsystemCheck,
  HOST_PROXY_SPEC,
  buildDegradedCheck,
  passCheck,
} from "./doctor-subsystem-checks";

export const buildHostProxyCheck = Effect.fnUntraced(function* (
  hostProxy: typeof HostProxyService.Service,
  fix: boolean,
): Effect.fn.Return<DoctorSubsystemCheck, never, HostDnsResolver> {
  const baseDomain = (yield* resolveProxyDefaultDomain).trim().toLowerCase().replace(/\.+$/, "");
  const status = yield* Effect.result(hostProxy.status());
  const context: Record<string, string> = {
    subsystem: "host-proxy",
    subsystemId: hostProxy.id,
    ...(Result.isSuccess(status)
      ? {
          active: String(status.success.active),
          mode: status.success.mode,
          mechanism: status.success.mechanism,
          baseDomain,
          loopback: status.success.loopback,
        }
      : { active: "false", baseDomain }),
  };
  if (Result.isFailure(status)) {
    return yield* buildDegradedCheck(HOST_PROXY_SPEC, context, fix, undefined, status.failure);
  }

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
        Effect.map(
          (addresses) =>
            addresses.length > 0 && addresses.every((address) => address === status.success.loopback),
        ),
      ),
    ),
  );
  const addresses = yield* Ref.get(addressesRef);
  const dnsReady = Result.isSuccess(resolved) && resolved.success.outcome === "green";
  const dnsContext = {
    ...context,
    dnsHostname: hostname,
    dnsResolved: String(dnsReady),
    ...(addresses.length === 0 ? {} : { dnsAddresses: addresses.join(",") }),
  };
  if (dnsReady) return passCheck(HOST_PROXY_SPEC, dnsContext);

  const cause =
    baseDomain === DEFAULT_PROXY_DOMAIN
      ? `${baseDomain} relies on public DNS, which fails offline or behind a resolver that drops loopback answers (DNS-rebinding protection).`
      : `Lando does not configure DNS for ${baseDomain}.`;
  const manualRemediation = `Host DNS does not resolve ${hostname} to ${status.success.loopback}. ${cause} Add a local DNS rule (dnsmasq or your OS resolver) that resolves *.${baseDomain} to ${status.success.loopback}, then run \`lando doctor\` again.`;
  if (!status.success.active) {
    return {
      name: HOST_PROXY_SPEC.name,
      status: "warn",
      severity: "warn",
      recovery: "manual",
      context: {
        ...dnsContext,
        ...(fix ? { fixOutcome: "skipped-manual" } : {}),
      },
      solutions: [{ kind: "manual", description: manualRemediation }],
    };
  }
  return yield* buildDegradedCheck({ ...HOST_PROXY_SPEC, manualRemediation }, dnsContext, fix);
});
