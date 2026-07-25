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
import { Data, Effect, Either, Layer } from "effect";

import {
  CertificateAuthority,
  HealthcheckRunner,
  HostProxyService,
  ProxyService,
  RuntimeProvider,
  SshService,
  UrlScanner,
} from "@lando/sdk/services";

import { HttpClientLive } from "../../http-client/live.ts";
import { runtimeProviderService } from "../../runtime/bootstrap-layer-support.ts";
import { CertificateAuthorityUnavailableLive } from "../../subsystems/certs/api.ts";
import { HealthcheckRunnerLive } from "../../subsystems/healthcheck/live.ts";
import { HostProxyServiceDisabledLive } from "../../subsystems/host-proxy/api.ts";
import { ProxyServiceUnavailableLive } from "../../subsystems/proxy/api.ts";
import { UrlScannerLive } from "../../subsystems/scanner/live.ts";
import { SshServiceUnavailableLive } from "../../subsystems/ssh/api.ts";
import { redactString } from "../redact.ts";
import { orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson.ts";
import { renderSolution } from "./doctor.ts";
import type { DoctorSeverity, DoctorSolution, DoctorStatus } from "./doctor.ts";

/**
 * Whether a degraded subsystem can be recovered automatically by re-running its
 * `setup()` step (`automatic`) or requires a manual remediation because the
 * recovery is privileged or no in-process setup step exists (`manual`).
 */
export type SubsystemRecovery = "automatic" | "manual";

/**
 * A subsystem diagnostic entry with `name`, `status`, `severity`, `recovery`,
 * `context`, and `solutions` fields.
 */
export interface DoctorSubsystemCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly recovery: SubsystemRecovery;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
}

export interface SubsystemDoctorResult {
  readonly checks: ReadonlyArray<DoctorSubsystemCheck>;
}

export interface SubsystemDoctorOptions {
  /**
   * Re-run the setup step of degraded subsystems whose recovery is classified
   * `automatic`. Privileged / no-setup subsystems are never auto-run.
   */
  readonly fix?: boolean;
}

/**
 * A `lando doctor` subsystem failure mapped to a tagged diagnostic that carries
 * the diagnostic `severity` and `solution`. This wraps a subsystem's tagged
 * failure (e.g. `ProxyError`, `CaError`) without modifying the
 * compatibility-locked SDK error classes.
 */
export class DoctorSubsystemFailure extends Data.TaggedError("DoctorSubsystemFailure")<{
  readonly subsystem: string;
  readonly severity: DoctorSeverity;
  readonly solution: DoctorSolution;
  readonly cause?: unknown;
}> {}

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
  ProxyService | CertificateAuthority | SshService | HealthcheckRunner | UrlScanner | HostProxyService
> = Layer.mergeAll(
  ProxyServiceUnavailableLive,
  CertificateAuthorityUnavailableLive,
  SshServiceUnavailableLive,
  HealthcheckRunnerDoctorLive,
  UrlScannerDoctorLive,
  HostProxyServiceDisabledLive,
);

/**
 * Service identities that indicate the subsystem is not yet wired to a real
 * implementation (fallback/disabled stubs).
 */
const NOT_READY_SUBSYSTEM_IDS: ReadonlySet<string> = new Set(["unavailable", "disabled"]);

const manualSetupSolution = (description: string): DoctorSolution => ({
  kind: "manual",
  description,
  command: "lando setup",
});

const automaticFixSolution = (description: string): DoctorSolution => ({
  kind: "automatic",
  description,
  command: "lando doctor --fix",
});

interface SubsystemSpec {
  readonly name: string;
  readonly recovery: SubsystemRecovery;
  /**
   * Remediation shown for `manual` subsystems and as the fallback when an
   * `automatic` recovery attempt fails.
   */
  readonly manualRemediation: string;
  /**
   * Remediation advertised for a degraded `automatic` subsystem in read-only
   * mode (before `--fix` is run).
   */
  readonly automaticRemediation?: string;
}

const PROXY_SPEC: SubsystemSpec = {
  name: "proxy",
  recovery: "automatic",
  automaticRemediation:
    "The HTTPS reverse proxy is not running. Run `lando doctor --fix` to re-provision Traefik routing through the global app.",
  manualRemediation:
    "The HTTPS reverse proxy is not available yet. Run `lando setup` and start the global app to enable Traefik routing.",
};

const CERTS_SPEC: SubsystemSpec = {
  name: "certs",
  recovery: "manual",
  manualRemediation:
    "The local certificate authority is not installed. Run `lando setup` to install and trust the dev CA.",
};

const SSH_SPEC: SubsystemSpec = {
  name: "ssh",
  recovery: "automatic",
  automaticRemediation:
    "The SSH agent sidecar is not available. Run `lando doctor --fix` to re-provision SSH agent forwarding.",
  manualRemediation:
    "The SSH agent sidecar is not available. Run `lando setup` to provision SSH agent forwarding.",
};

const HEALTHCHECK_SPEC: SubsystemSpec = {
  name: "healthcheck",
  recovery: "manual",
  manualRemediation:
    "The healthcheck engine is not ready. Run `lando setup` to provision the runtime provider it depends on.",
};

const SCANNER_SPEC: SubsystemSpec = {
  name: "scanner",
  recovery: "manual",
  manualRemediation:
    "The endpoint scanner is not ready. Run `lando setup` to provision the runtime provider it depends on.",
};

const HOST_PROXY_SPEC: SubsystemSpec = {
  name: "host-proxy",
  recovery: "manual",
  manualRemediation:
    "Hostname resolution for *.lndo.site is not active. Run `lando setup` to configure host DNS (or `lando setup --host-proxy=none` to manage DNS yourself).",
};

const SUBSYSTEM_SPECS: ReadonlyArray<SubsystemSpec> = [
  PROXY_SPEC,
  CERTS_SPEC,
  SSH_SPEC,
  HEALTHCHECK_SPEC,
  SCANNER_SPEC,
  HOST_PROXY_SPEC,
];

const SPEC_BY_NAME: ReadonlyMap<string, SubsystemSpec> = new Map(
  SUBSYSTEM_SPECS.map((spec) => [spec.name, spec] as const),
);

/**
 * The solution advertised for a degraded subsystem in read-only mode:
 * `automatic` subsystems point at `lando doctor --fix`; `manual` subsystems
 * point at `lando setup`.
 */
const degradedSolution = (spec: SubsystemSpec): DoctorSolution =>
  spec.recovery === "automatic" && spec.automaticRemediation !== undefined
    ? automaticFixSolution(spec.automaticRemediation)
    : manualSetupSolution(spec.manualRemediation);

/**
 * Map a subsystem's failure path to a tagged diagnostic carrying `severity`
 * and `solution`. Returns `undefined` for an unknown subsystem name.
 */
export const classifySubsystemFailure = (
  subsystem: string,
  cause?: unknown,
): DoctorSubsystemFailure | undefined => {
  const spec = SPEC_BY_NAME.get(subsystem);
  if (spec === undefined) return undefined;
  return new DoctorSubsystemFailure({
    subsystem,
    severity: "warn",
    solution: degradedSolution(spec),
    ...(cause === undefined ? {} : { cause }),
  });
};

/**
 * Public alias for `classifySubsystemFailure` that always returns a diagnostic
 * for the six known subsystems.
 */
export const subsystemFailureDiagnostic = (subsystem: string, cause?: unknown): DoctorSubsystemFailure => {
  const diagnostic = classifySubsystemFailure(subsystem, cause);
  if (diagnostic !== undefined) return diagnostic;
  return new DoctorSubsystemFailure({
    subsystem,
    severity: "warn",
    solution: manualSetupSolution(
      `The ${subsystem} subsystem is not available. Run \`lando setup\` to provision it.`,
    ),
    ...(cause === undefined ? {} : { cause }),
  });
};

const errorMessage = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return redactString(message);
  }
  return redactString(String(cause));
};

const passCheck = (spec: SubsystemSpec, context: Record<string, string>): DoctorSubsystemCheck => ({
  name: spec.name,
  status: "pass",
  severity: "info",
  recovery: spec.recovery,
  context,
  solutions: [],
});

/**
 * Build a degraded subsystem check, applying `--fix` recovery semantics:
 * `automatic` subsystems re-run `setup()` (success → recovered, failure →
 * manual fallback); `manual` subsystems are never auto-run.
 */
const buildDegradedCheck = (
  spec: SubsystemSpec,
  baseContext: Record<string, string>,
  fix: boolean,
  runSetup?: () => Effect.Effect<void, unknown>,
  cause?: unknown,
): Effect.Effect<DoctorSubsystemCheck, never> =>
  Effect.gen(function* () {
    if (fix && spec.recovery === "automatic" && runSetup !== undefined) {
      const fixCommand = `${spec.name}.setup`;
      const result = yield* Effect.either(runSetup());
      if (Either.isRight(result)) {
        return passCheck(spec, {
          ...baseContext,
          ...(baseContext.ready === "false" ? { ready: "true" } : {}),
          fixOutcome: "recovered",
          fixCommand,
          fixExitCode: "0",
        });
      }
      const diagnostic = subsystemFailureDiagnostic(spec.name, result.left);
      return {
        name: spec.name,
        status: "warn",
        severity: diagnostic.severity,
        recovery: spec.recovery,
        context: {
          ...baseContext,
          fixOutcome: "failed",
          fixCommand,
          fixExitCode: "1",
          fixError: errorMessage(result.left),
        },
        solutions: [manualSetupSolution(spec.manualRemediation)],
      };
    }

    if (fix) {
      return {
        name: spec.name,
        status: "warn",
        severity: "warn",
        recovery: spec.recovery,
        context: { ...baseContext, fixOutcome: "skipped-manual" },
        solutions: [manualSetupSolution(spec.manualRemediation)],
      };
    }

    const diagnostic = cause === undefined ? undefined : subsystemFailureDiagnostic(spec.name, cause);
    return {
      name: spec.name,
      status: "warn",
      severity: diagnostic?.severity ?? "warn",
      recovery: spec.recovery,
      context: baseContext,
      solutions: [diagnostic?.solution ?? degradedSolution(spec)],
    };
  });

/**
 * Probe an identity-based subsystem (ready iff its service id is not a
 * fallback/disabled stub).
 */
const buildIdCheck = (
  spec: SubsystemSpec,
  serviceId: string,
  fix: boolean,
  runSetup?: () => Effect.Effect<void, unknown>,
): Effect.Effect<DoctorSubsystemCheck, never> => {
  const ready = !NOT_READY_SUBSYSTEM_IDS.has(serviceId);
  const baseContext: Record<string, string> = {
    subsystem: spec.name,
    subsystemId: serviceId,
    ready: String(ready),
  };
  if (ready) return Effect.succeed(passCheck(spec, baseContext));
  return buildDegradedCheck(spec, baseContext, fix, runSetup);
};

/**
 * Probe the host DNS proxy via its `status()` method. Host-proxy recovery is
 * always `manual` because the DNS writes are privileged.
 */
const buildHostProxyCheck = (
  hostProxy: typeof HostProxyService.Service,
  fix: boolean,
): Effect.Effect<DoctorSubsystemCheck, never> =>
  Effect.gen(function* () {
    const status = yield* Effect.either(hostProxy.status());
    if (
      Either.isRight(status) &&
      (status.right.active || (status.right.mode === "none" && status.right.mechanism === "skipped"))
    ) {
      const value = status.right;
      return passCheck(HOST_PROXY_SPEC, {
        subsystem: "host-proxy",
        subsystemId: hostProxy.id,
        active: String(value.active),
        mode: value.mode,
        mechanism: value.mechanism,
        baseDomain: value.baseDomain,
        loopback: value.loopback,
      });
    }
    const baseContext: Record<string, string> = Either.isRight(status)
      ? {
          subsystem: "host-proxy",
          subsystemId: hostProxy.id,
          active: String(status.right.active),
          mode: status.right.mode,
          mechanism: status.right.mechanism,
          baseDomain: status.right.baseDomain,
          loopback: status.right.loopback,
        }
      : {
          subsystem: "host-proxy",
          subsystemId: hostProxy.id,
          active: "false",
        };
    return yield* buildDegradedCheck(
      HOST_PROXY_SPEC,
      baseContext,
      fix,
      undefined,
      Either.isLeft(status) ? status.left : undefined,
    );
  });

/**
 * Build the subsystem diagnostics using only the six subsystem service tags.
 */
export const subsystemDoctor = (
  options: SubsystemDoctorOptions = {},
): Effect.Effect<
  SubsystemDoctorResult,
  never,
  ProxyService | CertificateAuthority | SshService | HealthcheckRunner | UrlScanner | HostProxyService
> =>
  Effect.gen(function* () {
    const fix = options.fix === true;
    const proxy = yield* ProxyService;
    const ca = yield* CertificateAuthority;
    const ssh = yield* SshService;
    const healthcheck = yield* HealthcheckRunner;
    const scanner = yield* UrlScanner;
    const hostProxy = yield* HostProxyService;

    const proxyCheck = yield* buildIdCheck(PROXY_SPEC, proxy.id, fix, () =>
      Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" })),
    );
    const certsCheck = yield* buildIdCheck(CERTS_SPEC, ca.id, fix);
    const sshCheck = yield* buildIdCheck(SSH_SPEC, ssh.id, fix, () => ssh.setup({ force: false }));
    const healthcheckCheck = yield* buildIdCheck(HEALTHCHECK_SPEC, healthcheck.id, fix);
    const scannerCheck = yield* buildIdCheck(SCANNER_SPEC, scanner.id, fix);
    const hostProxyCheck = yield* buildHostProxyCheck(hostProxy, fix);

    return {
      checks: [proxyCheck, certsCheck, sshCheck, healthcheckCheck, scannerCheck, hostProxyCheck],
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
  "active",
  "mode",
  "mechanism",
  "baseDomain",
  "loopback",
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
