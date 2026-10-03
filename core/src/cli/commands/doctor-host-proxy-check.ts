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

export const buildHostProxyCheck = (
  hostProxy: typeof HostProxyService.Service,
  fix: boolean,
): Effect.Effect<DoctorSubsystemCheck, never, HostDnsResolver> =>
  Effect.gen(function* () {
    const status = yield* Effect.result(hostProxy.status());
    const context: Record<string, string> = {
      subsystem: "host-proxy",
      subsystemId: hostProxy.id,
      ...(Result.isSuccess(status)
        ? {
            active: String(status.success.active),
            mode: status.success.mode,
            mechanism: status.success.mechanism,
            baseDomain: status.success.baseDomain,
            loopback: status.success.loopback,
          }
        : { active: "false" }),
    };
    if (Result.isFailure(status)) {
      return yield* buildDegradedCheck(HOST_PROXY_SPEC, context, fix, undefined, status.failure);
    }

    const resolver = yield* HostDnsResolver;
    const hostname = `lando-doctor-probe.${status.success.baseDomain}`;
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

    const manualRemediation = status.success.active
      ? `Host DNS does not resolve ${hostname} to ${status.success.loopback}. Run \`lando setup\` to repair the active DNS integration.`
      : `Host DNS does not resolve ${hostname} to ${status.success.loopback}. Configure a local DNS rule for *.${status.success.baseDomain} to point to ${status.success.loopback}, then run \`lando doctor\` again.`;
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
