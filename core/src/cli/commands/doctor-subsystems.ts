/**
 * Subsystem diagnostics for `lando doctor`.
 *
 * Aggregates the status of each `lando doctor` subsystem (proxy, certificate
 * authority, SSH agent, healthcheck engine, endpoint scanner, host DNS proxy)
 * into a diagnostic record with `status`, `severity`, `recovery`, `context`,
 * and `solution` fields.
 *
 * The checks are read-only by default: each subsystem is probed through its
 * published Effect service tag, and the bundled fallback/disabled Live Layers
 * provide the identity/status data without mutating host state.
 *
 * When `--fix` is requested, a degraded subsystem whose recovery is classified
 * `automatic` (non-privileged, exposes a re-runnable `setup()` step) has its
 * setup step re-run in-process; the attempt outcome is reported as
 * command-shaped metadata. Subsystems classified `manual` — privileged
 * operations (CA trust-store install, host DNS writes) or subsystems with no
 * `setup()` recovery step — are never auto-run and always fall back to a manual
 * remediation, matching the no-silent-elevation rule for diagnostics.
 */
import { Effect, Layer } from "effect";

import {
  HealthcheckRunner,
  HostProxyService,
  RouterService,
  RuntimeProvider,
  SshService,
  UrlScanner,
} from "@lando/sdk/services";

import { runtimeProviderService } from "@lando/engine/runtime/bootstrap-layer-support";
import * as ProviderHealthcheckRunner from "@lando/engine/subsystems/healthcheck/live";
import * as HostProxyServiceLayer from "@lando/engine/subsystems/host-proxy/api";
import * as RouterServiceLayer from "@lando/engine/subsystems/proxy/api";
import * as ProviderUrlScanner from "@lando/engine/subsystems/scanner/live";
import * as SshServiceLayer from "@lando/engine/subsystems/ssh/api";
import * as LandoHttpClient from "@lando/http-client/live";
import {
  type CertsDoctorStatus,
  UNRESOLVED_CERTS_STATUS,
  certsCheckContext,
  certsSubsystemId,
} from "./doctor-certs-status";
import { HostDnsResolver } from "./doctor-host-dns";
import { buildHostProxyCheck } from "./doctor-host-proxy-check";
import { doctorSolutionPayloads, orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson";
import type { NetworkTrustDoctorStatus } from "./doctor-network-trust";
import { buildProxyCheck } from "./doctor-proxy-check";
import { renderSectionCheck } from "./doctor-section-render";
import { type SshAgentDoctorOptions, sshAgentPostureCheck } from "./doctor-ssh-agent";
import {
  CERTS_SPEC,
  type DoctorSubsystemCheck,
  HEALTHCHECK_SPEC,
  SCANNER_SPEC,
  buildIdCheck,
} from "./doctor-subsystem-checks";

export {
  DoctorSubsystemFailure,
  classifySubsystemFailure,
  subsystemFailureDiagnostic,
  type DoctorSubsystemCheck,
  type SubsystemRecovery,
} from "./doctor-subsystem-checks";

export interface SubsystemDoctorResult {
  readonly checks: ReadonlyArray<DoctorSubsystemCheck>;
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

// Healthcheck/scanner doctor reads only the runner `id`, never invoking
// `run()`/`scan()`, so the bootstrap placeholder provider satisfies the real
// layers' dependencies while keeping `DefaultSubsystemDoctorLayer` self-contained.
// Proxy readiness additionally reads `status()`.
const doctorRuntimeProviderLayer = Layer.succeed(RuntimeProvider, RuntimeProvider.of(runtimeProviderService));

const healthcheckRunnerDoctorLayer = ProviderHealthcheckRunner.layer.pipe(
  Layer.provide(doctorRuntimeProviderLayer),
);

const urlScannerDoctorLayer = ProviderUrlScanner.layer.pipe(
  Layer.provide(Layer.mergeAll(doctorRuntimeProviderLayer, LandoHttpClient.layer)),
);

export const DefaultSubsystemDoctorLayer: Layer.Layer<
  RouterService | SshService | HealthcheckRunner | UrlScanner | HostProxyService | HostDnsResolver
> = Layer.mergeAll(
  RouterServiceLayer.layerUnavailable,
  SshServiceLayer.layerUnavailable,
  healthcheckRunnerDoctorLayer,
  urlScannerDoctorLayer,
  HostProxyServiceLayer.layerDisabled,
  HostDnsResolver.layer,
);

export const subsystemDoctor = Effect.fn("DoctorSubsystems.check")(function* (
  options: SubsystemDoctorOptions = {},
): Effect.fn.Return<
  SubsystemDoctorResult,
  never,
  RouterService | SshService | HealthcheckRunner | UrlScanner | HostProxyService | HostDnsResolver
> {
  const fix = options.fix === true;
  const proxy = yield* RouterService;
  const ssh = yield* SshService;
  const healthcheck = yield* HealthcheckRunner;
  const scanner = yield* UrlScanner;
  const hostProxy = yield* HostProxyService;

  const proxyCheck = yield* buildProxyCheck(proxy, fix);
  const certs = options.certs ?? UNRESOLVED_CERTS_STATUS;
  const certsCheck = yield* buildIdCheck(CERTS_SPEC, certsSubsystemId(certs), fix).pipe(
    Effect.map((check) => ({
      ...check,
      context: { ...check.context, ...certsCheckContext(certs) },
    })),
  );
  const sshCheck = yield* sshAgentPostureCheck({ ...options.sshAgent, sshService: ssh, fix });
  const healthcheckCheck = yield* buildIdCheck(HEALTHCHECK_SPEC, healthcheck.id, fix);
  const scannerCheck = yield* buildIdCheck(SCANNER_SPEC, scanner.id, fix);
  const hostProxyCheck = yield* buildHostProxyCheck(hostProxy, fix);

  return {
    checks: [
      proxyCheck,
      certsCheck,
      sshCheck,
      healthcheckCheck,
      scannerCheck,
      hostProxyCheck,
      ...(options.networkTrust === undefined ? [] : [options.networkTrust]),
    ],
  };
});

export const renderSubsystemDoctorResult = (result: SubsystemDoctorResult): string =>
  result.checks.flatMap((check) => renderSectionCheck(check, { skipContextKeys: ["subsystem"] })).join("\n");

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
