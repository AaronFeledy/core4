/**
 * Subsystem diagnostics for `lando doctor`.
 *
 * Aggregates the status of each subsystem used by `lando doctor` (proxy,
 * certificate authority, SSH agent, healthcheck engine, endpoint scanner,
 * host DNS proxy) into a diagnostic record with `status`, `severity`,
 * `context`, and `solution` fields.
 *
 * The checks are read-only and never bootstrap an app: each subsystem is probed
 * through its published Effect service tag, which is satisfied by the bundled
 * default Live Layers (the fallback/disabled stubs until the global app + bundled
 * plugins wire the production layers). Probing reads a subsystem's identity (and,
 * for the host proxy, its structured status) without mutating host state.
 */
import { Effect, Layer } from "effect";

import {
  CertificateAuthority,
  HealthcheckRunner,
  HostProxyService,
  ProxyService,
  SshService,
  UrlScanner,
} from "@lando/sdk/services";

import { CertificateAuthorityUnavailableLive } from "../../subsystems/certs/api.ts";
import { HealthcheckRunnerUnavailableLive } from "../../subsystems/healthcheck/api.ts";
import { HostProxyServiceDisabledLive } from "../../subsystems/host-proxy/api.ts";
import { ProxyServiceUnavailableLive } from "../../subsystems/proxy/api.ts";
import { UrlScannerUnavailableLive } from "../../subsystems/scanner/api.ts";
import { SshServiceUnavailableLive } from "../../subsystems/ssh/api.ts";
import { renderSolution } from "./doctor.ts";
import type { DoctorSeverity, DoctorSolution, DoctorStatus } from "./doctor.ts";

/**
 * A single subsystem diagnostic entry with `name`, `status`, `severity`,
 * `context`, and `solutions` fields.
 */
export interface DoctorSubsystemCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
}

export interface SubsystemDoctorResult {
  readonly checks: ReadonlyArray<DoctorSubsystemCheck>;
}

/**
 * Default Live Layers used to probe subsystem status from `lando doctor`. These
 * are the bundled fallback/disabled stubs; none of them require app bootstrap,
 * a running provider, or any other ambient service.
 */
export const DefaultSubsystemDoctorLayer: Layer.Layer<
  ProxyService | CertificateAuthority | SshService | HealthcheckRunner | UrlScanner | HostProxyService
> = Layer.mergeAll(
  ProxyServiceUnavailableLive,
  CertificateAuthorityUnavailableLive,
  SshServiceUnavailableLive,
  HealthcheckRunnerUnavailableLive,
  UrlScannerUnavailableLive,
  HostProxyServiceDisabledLive,
);

/**
 * Service identities that indicate the subsystem is not yet wired to a real
 * implementation (fallback/disabled stubs).
 */
const NOT_READY_SUBSYSTEM_IDS: ReadonlySet<string> = new Set(["unavailable", "disabled"]);

const setupSolution = (description: string): DoctorSolution => ({
  kind: "manual",
  description,
  command: "lando setup",
});

interface ReadinessSpec {
  readonly name: string;
  readonly remediation: string;
}

const readinessCheck = (spec: ReadinessSpec, serviceId: string): DoctorSubsystemCheck => {
  const ready = !NOT_READY_SUBSYSTEM_IDS.has(serviceId);
  return {
    name: spec.name,
    status: ready ? "pass" : "warn",
    severity: ready ? "info" : "warn",
    context: {
      subsystem: spec.name,
      subsystemId: serviceId,
      ready: String(ready),
    },
    solutions: ready ? [] : [setupSolution(spec.remediation)],
  };
};

const PROXY_SPEC: ReadinessSpec = {
  name: "proxy",
  remediation:
    "The HTTPS reverse proxy is not available yet. Run `lando setup` and start the global app to enable Traefik routing.",
};

const CERTS_SPEC: ReadinessSpec = {
  name: "certs",
  remediation:
    "The local certificate authority is not installed. Run `lando setup` to install and trust the dev CA.",
};

const SSH_SPEC: ReadinessSpec = {
  name: "ssh",
  remediation: "The SSH agent sidecar is not available. Run `lando setup` to provision SSH agent forwarding.",
};

const HEALTHCHECK_SPEC: ReadinessSpec = {
  name: "healthcheck",
  remediation:
    "The healthcheck engine is not ready. Run `lando setup` to provision the runtime provider it depends on.",
};

const SCANNER_SPEC: ReadinessSpec = {
  name: "scanner",
  remediation:
    "The endpoint scanner is not ready. Run `lando setup` to provision the runtime provider it depends on.",
};

const HOST_PROXY_INACTIVE_REMEDIATION =
  "Hostname resolution for *.lndo.site is not active. Run `lando setup` to configure host DNS (or `lando setup --host-proxy=none` to manage DNS yourself).";

/**
 * Build the subsystem diagnostics. Requires only the six subsystem service tags;
 * never bootstraps an app or a running provider.
 */
export const subsystemDoctor = (): Effect.Effect<
  SubsystemDoctorResult,
  never,
  ProxyService | CertificateAuthority | SshService | HealthcheckRunner | UrlScanner | HostProxyService
> =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService;
    const ca = yield* CertificateAuthority;
    const ssh = yield* SshService;
    const healthcheck = yield* HealthcheckRunner;
    const scanner = yield* UrlScanner;
    const hostProxy = yield* HostProxyService;

    const hostProxyStatus = yield* hostProxy.status().pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const hostProxyCheck: DoctorSubsystemCheck =
      hostProxyStatus === undefined
        ? {
            name: "host-proxy",
            status: "warn",
            severity: "warn",
            context: {
              subsystem: "host-proxy",
              subsystemId: hostProxy.id,
              active: "false",
            },
            solutions: [setupSolution(HOST_PROXY_INACTIVE_REMEDIATION)],
          }
        : {
            name: "host-proxy",
            status: hostProxyStatus.active ? "pass" : "warn",
            severity: hostProxyStatus.active ? "info" : "warn",
            context: {
              subsystem: "host-proxy",
              subsystemId: hostProxy.id,
              active: String(hostProxyStatus.active),
              mode: hostProxyStatus.mode,
              mechanism: hostProxyStatus.mechanism,
              baseDomain: hostProxyStatus.baseDomain,
              loopback: hostProxyStatus.loopback,
            },
            solutions: hostProxyStatus.active ? [] : [setupSolution(HOST_PROXY_INACTIVE_REMEDIATION)],
          };

    return {
      checks: [
        readinessCheck(PROXY_SPEC, proxy.id),
        readinessCheck(CERTS_SPEC, ca.id),
        readinessCheck(SSH_SPEC, ssh.id),
        readinessCheck(HEALTHCHECK_SPEC, healthcheck.id),
        readinessCheck(SCANNER_SPEC, scanner.id),
        hostProxyCheck,
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
  "active",
  "mode",
  "mechanism",
  "baseDomain",
  "loopback",
];

const orderContextKeys = (context: Readonly<Record<string, string>>): Record<string, string> => {
  const ordered: Record<string, string> = {};
  for (const key of CONTEXT_KEY_ORDER) {
    if (Object.hasOwn(context, key)) ordered[key] = context[key] as string;
  }
  for (const [key, value] of Object.entries(context)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  }
  return ordered;
};

const checkEventPayload = (check: DoctorSubsystemCheck): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: check.name,
  status: check.status,
  severity: check.severity,
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
): string => {
  const timestamp = (options.now ?? new Date()).toISOString();
  const lines: string[] = [];
  lines.push(JSON.stringify({ _tag: "doctor.start", timestamp }));
  for (const check of result.checks) {
    lines.push(JSON.stringify(checkEventPayload(check)));
  }
  let failed = 0;
  let warned = 0;
  for (const check of result.checks) {
    if (check.status === "fail") failed += 1;
    else if (check.status === "warn") warned += 1;
  }
  lines.push(
    JSON.stringify({
      _tag: "doctor.complete",
      timestamp,
      checks: result.checks.length,
      failed,
      warned,
    }),
  );
  return `${lines.join("\n")}\n`;
};
