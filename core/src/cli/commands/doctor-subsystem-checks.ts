import { Data, Effect, Either } from "effect";

import { redactString } from "../redact.ts";
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

export interface SubsystemSpec {
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

export const PROXY_SPEC: SubsystemSpec = {
  name: "proxy",
  recovery: "automatic",
  automaticRemediation:
    "The HTTPS reverse proxy is not running. Run `lando doctor --fix` to re-provision Traefik routing through the global app.",
  manualRemediation:
    "The HTTPS reverse proxy is not available yet. Run `lando setup` and start the global app to enable Traefik routing.",
};

export const CERTS_SPEC: SubsystemSpec = {
  name: "certs",
  recovery: "manual",
  manualRemediation:
    "The local certificate authority is not installed. Run `lando setup` to install and trust the dev CA.",
};

export const SSH_SPEC: SubsystemSpec = {
  name: "ssh",
  recovery: "automatic",
  automaticRemediation:
    "The SSH agent sidecar is not available. Run `lando doctor --fix` to re-provision SSH agent forwarding.",
  manualRemediation:
    "The SSH agent sidecar is not available. Run `lando setup` to provision SSH agent forwarding.",
};

export const HEALTHCHECK_SPEC: SubsystemSpec = {
  name: "healthcheck",
  recovery: "manual",
  manualRemediation:
    "The healthcheck engine is not ready. Run `lando setup` to provision the runtime provider it depends on.",
};

export const SCANNER_SPEC: SubsystemSpec = {
  name: "scanner",
  recovery: "manual",
  manualRemediation:
    "The endpoint scanner is not ready. Run `lando setup` to provision the runtime provider it depends on.",
};

export const HOST_PROXY_SPEC: SubsystemSpec = {
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

export const passCheck = (spec: SubsystemSpec, context: Record<string, string>): DoctorSubsystemCheck => ({
  name: spec.name,
  status: "pass",
  severity: "info",
  recovery: spec.recovery,
  context,
  solutions: [],
});

export const buildDegradedCheck = (
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
export const buildIdCheck = (
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
