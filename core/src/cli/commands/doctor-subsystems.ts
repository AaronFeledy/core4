import { unavailableRouterReason } from "@lando/engine/subsystems/proxy/api";
import { RouterService, SshService } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { DoctorFinding, DoctorSectionResult } from "./doctor-contract";
import { idleGlobalProvider } from "./doctor-global-runtime";
import { HostDnsResolver } from "./doctor-host-dns";
import { buildHostDnsCheck } from "./doctor-host-dns-check";
import { buildProxyCheck } from "./doctor-proxy-check";
import { type SshAgentDoctorOptions, sshAgentPostureCheck } from "./doctor-ssh-agent";

export {
  classifySubsystemFailure,
  subsystemFailureDiagnostic,
} from "./doctor-subsystem-checks";

export interface SubsystemDoctorOptions {
  /**
   * Re-run the setup step of degraded subsystems whose recovery is classified
   * `automatic`. Privileged / no-setup subsystems are never auto-run.
   */
  readonly fix?: boolean;
  readonly sshAgent?: SshAgentDoctorOptions;
}

export const subsystemDoctor = Effect.fn("DoctorSubsystems.check")(function* (
  options: SubsystemDoctorOptions = {},
): Effect.fn.Return<DoctorSectionResult, never> {
  const fix = options.fix === true;
  const proxy = Option.getOrUndefined(yield* Effect.serviceOption(RouterService));
  const ssh = Option.getOrUndefined(yield* Effect.serviceOption(SshService));
  const resolver = yield* Effect.serviceOption(HostDnsResolver);
  const idleProvider = yield* idleGlobalProvider;

  // Router selection is host-side metadata, so an unselectable router is reported even when idle.
  const routerUnavailable = proxy !== undefined && unavailableRouterReason(proxy) !== undefined;
  const proxyChecks =
    proxy === undefined || (idleProvider !== undefined && !routerUnavailable)
      ? []
      : [yield* buildProxyCheck(proxy, fix)];
  const sshChecks =
    ssh === undefined
      ? []
      : [
          yield* sshAgentPostureCheck({
            ...options.sshAgent,
            sshService: ssh,
            fix,
            ...(idleProvider === undefined ? {} : { idleProvider }),
          }),
        ];
  const hostDnsChecks = Option.isNone(resolver)
    ? []
    : [yield* buildHostDnsCheck(fix).pipe(Effect.provideService(HostDnsResolver, resolver.value))];

  return {
    checks: [
      ...proxyChecks,
      ...sshChecks.flatMap((check): ReadonlyArray<DoctorFinding> => {
        if (check.context.sidecarSkipped !== "true") return [check];
        if (check.details === undefined || !("gpg" in check.details)) return [];
        const gpg = check.details.gpg;
        if (gpg === undefined) return [];
        const ready = gpg.upstream.reachable && gpg.keyringExported;
        return [
          {
            name: "gpg-agent",
            status: ready ? "pass" : "warn",
            severity: ready ? "info" : "warn",
            recovery: "manual",
            context: {
              subsystem: "gpg-agent",
              upstreamReachable: String(gpg.upstream.reachable),
              keyringExported: String(gpg.keyringExported),
            },
            solutions: ready
              ? []
              : [
                  {
                    kind: "manual",
                    description:
                      "Restore your host GPG agent and public keyring export, then rerun `lando doctor`.",
                  },
                ],
          },
        ];
      }),
      ...hostDnsChecks,
    ],
    skipped: [
      ...(idleProvider === undefined
        ? []
        : [
            ...(routerUnavailable ? [] : ["router"]),
            ...(sshChecks.some((check) => check.context.sidecarSkipped === "true") ? ["ssh-sidecar"] : []),
          ].map((check) => ({
            check,
            reason: `Provider ${idleProvider} holding the global app is idle; readiness was not inspected.`,
          }))),
      ...[["router", proxy] as const, ["ssh", ssh] as const].flatMap(([check, service]) =>
        service === undefined
          ? [
              {
                check,
                reason: "Runtime subsystem service was not provided; no inspection was performed.",
              },
            ]
          : [],
      ),
      ...(Option.isNone(resolver)
        ? [
            {
              check: "host-dns",
              reason: "Host DNS resolver was not provided; no host DNS inspection was performed.",
            },
          ]
        : []),
      {
        check: "healthcheck",
        reason:
          "No service healthcheck was executed against a selected available provider. Service readiness and build gates inspect healthchecks during lando start and rebuild.",
      },
      {
        check: "scanner",
        reason:
          "No app endpoints were inspected against a selected available provider. Endpoint scanning runs after lando start.",
      },
    ],
  };
});
