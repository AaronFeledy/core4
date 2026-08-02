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
  ProxyService,
  RuntimeProvider,
  SshService,
  UrlScanner,
} from "@lando/sdk/services";

import { HttpClientLive } from "../../http-client/live.ts";
import { runtimeProviderService } from "../../runtime/bootstrap-layer-support.ts";
import { HealthcheckRunnerLive } from "../../subsystems/healthcheck/live.ts";
import { HostProxyServiceDisabledLive } from "../../subsystems/host-proxy/api.ts";
import { ProxyServiceUnavailableLive } from "../../subsystems/proxy/api.ts";
import { UrlScannerLive } from "../../subsystems/scanner/live.ts";
import { SshServiceUnavailableLive } from "../../subsystems/ssh/api.ts";
import {
  type CertsDoctorStatus,
  UNRESOLVED_CERTS_STATUS,
  certsCheckContext,
  certsSubsystemId,
} from "./doctor-certs-status.ts";
import { buildHostProxyCheck } from "./doctor-host-proxy-check.ts";
import { orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson.ts";
import type { NetworkTrustDoctorStatus } from "./doctor-network-trust.ts";
import {
  CERTS_SPEC,
  type DoctorSubsystemCheck,
  HEALTHCHECK_SPEC,
  PROXY_SPEC,
  SCANNER_SPEC,
  SSH_SPEC,
  buildIdCheck,
} from "./doctor-subsystem-checks.ts";
import { renderSolution } from "./doctor.ts";

export {
  DoctorSubsystemFailure,
  classifySubsystemFailure,
  subsystemFailureDiagnostic,
  type DoctorSubsystemCheck,
  type SubsystemRecovery,
} from "./doctor-subsystem-checks.ts";

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
}

/**
 * Default Live Layers used to probe subsystem status from `lando doctor`.
 * These bundled fallback/disabled stubs do not require app bootstrap or any
 * other ambient service.
 */
// `subsystemDoctor` reads only the runner `id`, never invoking `run()`/`scan()`,
// so the bootstrap placeholder provider satisfies the real layers' dependencies
// while keeping `DefaultSubsystemDoctorLayer` self-contained.
const DoctorRuntimeProviderLive = Layer.succeed(RuntimeProvider, runtimeProviderService);

const HealthcheckRunnerDoctorLive = HealthcheckRunnerLive.pipe(Layer.provide(DoctorRuntimeProviderLive));

const UrlScannerDoctorLive = UrlScannerLive.pipe(
  Layer.provide(Layer.mergeAll(DoctorRuntimeProviderLive, HttpClientLive)),
);

export const DefaultSubsystemDoctorLayer: Layer.Layer<
  ProxyService | SshService | HealthcheckRunner | UrlScanner | HostProxyService
> = Layer.mergeAll(
  ProxyServiceUnavailableLive,
  SshServiceUnavailableLive,
  HealthcheckRunnerDoctorLive,
  UrlScannerDoctorLive,
  HostProxyServiceDisabledLive,
);

/**
 * Build the subsystem diagnostics using only the five subsystem service tags.
 */
export const subsystemDoctor = (
  options: SubsystemDoctorOptions = {},
): Effect.Effect<
  SubsystemDoctorResult,
  never,
  ProxyService | SshService | HealthcheckRunner | UrlScanner | HostProxyService
> =>
  Effect.gen(function* () {
    const fix = options.fix === true;
    const proxy = yield* ProxyService;
    const ssh = yield* SshService;
    const healthcheck = yield* HealthcheckRunner;
    const scanner = yield* UrlScanner;
    const hostProxy = yield* HostProxyService;

    const proxyCheck = yield* buildIdCheck(PROXY_SPEC, proxy.id, fix, () =>
      Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" })),
    );
    const certs = options.certs ?? UNRESOLVED_CERTS_STATUS;
    const certsCheck = yield* buildIdCheck(CERTS_SPEC, certsSubsystemId(certs), fix).pipe(
      Effect.map((check) => ({
        ...check,
        context: { ...check.context, ...certsCheckContext(certs) },
      })),
    );
    const sshCheck = yield* buildIdCheck(SSH_SPEC, ssh.id, fix, () => ssh.setup({ force: false }));
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

const renderCheck = (check: DoctorSubsystemCheck): ReadonlyArray<string> => {
  const lines = [`${check.name}: ${check.status}`, `severity: ${check.severity}`];
  for (const [field, value] of Object.entries(check.context)) {
    if (field === "subsystem") continue;
    lines.push(`${field}: ${value}`);
  }
  for (const solution of check.solutions) {
    lines.push(renderSolution(solution));
  }
  return lines;
};

export const renderSubsystemDoctorResult = (result: SubsystemDoctorResult): string =>
  result.checks.flatMap((check) => renderCheck(check)).join("\n");

const CONTEXT_KEY_ORDER: ReadonlyArray<string> = [
  "subsystem",
  "subsystemId",
  "ready",
  "certsReason",
  "certsCandidateIds",
  "certsPlugin",
  "certsDetail",
  "active",
  "mode",
  "mechanism",
  "baseDomain",
  "loopback",
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

const orderContextKeys = (context: Readonly<Record<string, string>>): Record<string, string> =>
  orderKnownKeys(context, CONTEXT_KEY_ORDER);

const checkEventPayload = (check: DoctorSubsystemCheck): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: check.name,
  status: check.status,
  severity: check.severity,
  recovery: check.recovery,
  context: orderContextKeys(check.context),
  solutions: check.solutions.map((solution) => ({
    kind: solution.kind,
    description: solution.description,
    ...(solution.command === undefined ? {} : { command: solution.command }),
  })),
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
