/**
 * Subsystem diagnostics for `lando doctor`.
 *
 * Aggregates the status of each `lando doctor` subsystem (proxy, certificate
 * authority, SSH agent, healthcheck engine, endpoint scanner, host DNS proxy)
 * into a diagnostic record with `status`, `severity`, `recovery`, `context`,
 * and `solution` fields.
 *
 * Checks inspect the runtime services supplied by the caller. Missing services
 * and probes that doctor does not execute are reported as skipped, not passed.
 *
 * When `--fix` is requested, a degraded subsystem whose recovery is classified
 * `automatic` (non-privileged, exposes a re-runnable `setup()` step) has its
 * setup step re-run in-process; the attempt outcome is reported as
 * command-shaped metadata. Subsystems classified `manual` — privileged
 * operations (CA trust-store install, host DNS writes) or subsystems with no
 * `setup()` recovery step — are never auto-run and always fall back to a manual
 * remediation, matching the no-silent-elevation rule for diagnostics.
 */
import { Effect, Option } from "effect";

import { HostProxyService, RouterService, SshService } from "@lando/sdk/services";

import {
  type CertsDoctorStatus,
  UNRESOLVED_CERTS_STATUS,
  certsCheckContext,
  certsSubsystemId,
} from "./doctor-certs-status";
import type { HostDnsResolver } from "./doctor-host-dns";
import { buildHostProxyCheck } from "./doctor-host-proxy-check";
import { doctorSolutionPayloads, orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson";
import type { NetworkTrustDoctorStatus } from "./doctor-network-trust";
import { buildProxyCheck } from "./doctor-proxy-check";
import { renderSectionCheck } from "./doctor-section-render";
import { type SshAgentDoctorOptions, sshAgentPostureCheck } from "./doctor-ssh-agent";
import { CERTS_SPEC, type DoctorSubsystemCheck, buildDegradedCheck } from "./doctor-subsystem-checks";

export {
  DoctorSubsystemFailure,
  classifySubsystemFailure,
  subsystemFailureDiagnostic,
  type DoctorSubsystemCheck,
  type SubsystemRecovery,
} from "./doctor-subsystem-checks";

export interface SubsystemDoctorResult {
  readonly checks: ReadonlyArray<DoctorSubsystemCheck>;
  readonly skipped?: ReadonlyArray<{
    readonly section: string;
    readonly status: "skipped";
    readonly reason: string;
  }>;
}

export interface SubsystemDoctorOptions {
  /**
   * Re-run the setup step of degraded subsystems whose recovery is classified
   * `automatic`. Privileged / no-setup subsystems are never auto-run.
   */
  readonly fix?: boolean;
  readonly certs?: CertsDoctorStatus;
  readonly networkTrust?: NetworkTrustDoctorStatus;
  readonly sshAgent?: SshAgentDoctorOptions;
}

export const subsystemDoctor = Effect.fn("DoctorSubsystems.check")(function* (
  options: SubsystemDoctorOptions = {},
): Effect.fn.Return<SubsystemDoctorResult, never, HostDnsResolver> {
  const fix = options.fix === true;
  const proxy = Option.getOrUndefined(yield* Effect.serviceOption(RouterService));
  const ssh = Option.getOrUndefined(yield* Effect.serviceOption(SshService));
  const hostProxy = Option.getOrUndefined(yield* Effect.serviceOption(HostProxyService));

  const proxyChecks = proxy === undefined ? [] : [yield* buildProxyCheck(proxy, fix)];
  const certs = options.certs ?? UNRESOLVED_CERTS_STATUS;
  const certsCheck =
    certs._tag === "selected"
      ? undefined
      : yield* buildDegradedCheck(
          CERTS_SPEC,
          {
            subsystem: "certs",
            subsystemId: certsSubsystemId(certs),
            ready: "false",
            ...certsCheckContext(certs),
          },
          fix,
        );
  const sshChecks =
    ssh === undefined ? [] : [yield* sshAgentPostureCheck({ ...options.sshAgent, sshService: ssh, fix })];
  const hostProxyChecks = hostProxy === undefined ? [] : [yield* buildHostProxyCheck(hostProxy, fix)];

  return {
    checks: [
      ...proxyChecks,
      ...(certsCheck === undefined ? [] : [certsCheck]),
      ...sshChecks,
      ...hostProxyChecks,
      ...(options.networkTrust === undefined ? [] : [options.networkTrust]),
    ],
    skipped: [
      ...(certsCheck === undefined
        ? [
            {
              section: "certs",
              status: "skipped" as const,
              reason:
                "A certificate authority was selected, but its installation and trust were not inspected; the certificate authority contract has no read-only inspection operation.",
            },
          ]
        : []),
      ...[["router", proxy] as const, ["ssh", ssh] as const, ["host-proxy", hostProxy] as const].flatMap(
        ([section, service]) =>
          service === undefined
            ? [
                {
                  section,
                  status: "skipped" as const,
                  reason: "Runtime subsystem service was not provided; no inspection was performed.",
                },
              ]
            : [],
      ),
      {
        section: "healthcheck",
        status: "skipped",
        reason:
          "No service healthcheck was executed against a selected available provider. Service readiness and build gates inspect healthchecks during lando start and rebuild.",
      },
      {
        section: "scanner",
        status: "skipped",
        reason:
          "No app endpoints were inspected against a selected available provider. Endpoint scanning runs after lando start.",
      },
    ],
  };
});

export const renderSubsystemDoctorResult = (result: SubsystemDoctorResult): string =>
  [
    ...result.checks.flatMap((check) => renderSectionCheck(check, { skipContextKeys: ["subsystem"] })),
    ...(result.skipped ?? []).map((entry) => `${entry.section}: SKIPPED · ${entry.reason}`),
  ].join("\n");

const CONTEXT_KEY_ORDER: ReadonlyArray<string> = [
  "subsystem",
  "subsystemId",
  "ready",
  "state",
  "acquisitionMode",
  "httpPort",
  "httpsPort",
  "certsReason",
  "certsCandidateIds",
  "certsPlugin",
  "certsDetail",
  "active",
  "mode",
  "mechanism",
  "baseDomain",
  "loopback",
  "dnsHostname",
  "dnsResolved",
  "dnsAddresses",
  "failure",
  "message",
  "remediation",
  "caConfigured",
  "caCount",
  "caLoaded",
  "caTrustHost",
  "caInjectIntoServices",
  "proxyConfigured",
  "proxyInjectIntoServices",
  "noProxyCount",
  "fixOutcome",
  "fixCommand",
  "fixExitCode",
  "fixError",
];

const checkEventPayload = (check: DoctorSubsystemCheck): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: check.name,
  status: check.status,
  severity: check.severity,
  recovery: check.recovery,
  context: orderKnownKeys(check.context, CONTEXT_KEY_ORDER),
  ...(check.details === undefined ? {} : { details: check.details }),
  solutions: doctorSolutionPayloads(check.solutions),
});

export interface SubsystemDoctorNdjsonOptions {
  readonly now?: Date;
}

export const renderSubsystemDoctorResultAsNdjson = (
  result: SubsystemDoctorResult,
  options: SubsystemDoctorNdjsonOptions = {},
): string =>
  renderDoctorChecksAsNdjson({
    checks: result.checks,
    now: options.now,
    checkEventPayload,
  });
