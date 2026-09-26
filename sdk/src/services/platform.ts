import { Context, type Effect, type Scope } from "effect";

import type {
  CaError,
  HealthcheckError,
  HealthcheckTimeoutError,
  HostProxyError,
  PortCollisionError,
  ProxyApplyError,
  ProxyError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
  ScannerError,
  SecretStoreError,
  SecretStoreUnavailableError,
  SshError,
} from "../errors/index.ts";
import type { ProbeOutcome } from "../probe/index.ts";
import type {
  AppId,
  AppPlan,
  HealthcheckPlan,
  ProxyApplyResult,
  ProxyCapabilities,
  ProxyConfig,
  ProxyStatus,
  RoutePlan,
  ServiceName,
} from "../schema/index.ts";
import type { PrivilegeService } from "./process.ts";

export interface CaSetupOptions {
  readonly force: boolean;
  readonly skipTrustInstall?: boolean;
  readonly privilege?: Context.Tag.Service<typeof PrivilegeService>;
}

export interface CertificateSpec {
  readonly cn: string;
  readonly sans: ReadonlyArray<string>;
}

export interface CertificateResult {
  readonly certPath: string;
  readonly keyPath: string;
  readonly caPath: string;
}

export interface CertificateAuthorityShape {
  readonly id: string;
  readonly setup: (options: CaSetupOptions) => Effect.Effect<void, CaError>;
  readonly issueCert: (spec: CertificateSpec) => Effect.Effect<CertificateResult, CaError>;
}

export class CertificateAuthority extends Context.Tag("@lando/core/CertificateAuthority")<
  CertificateAuthority,
  CertificateAuthorityShape
>() {}

export interface RouterServiceShape {
  readonly id: string;
  readonly capabilities: ProxyCapabilities;
  /** Resolve and persist route publication ports before starting required global services. */
  readonly prepare?: (
    config: ProxyConfig,
  ) => Effect.Effect<void, ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch>;
  readonly setup: (
    config: ProxyConfig,
    options?: { readonly autoApprove?: boolean },
  ) => Effect.Effect<
    void,
    ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch | RouterWatcherError,
    Scope.Scope
  >;
  /**
   * Re-observe router startup against the running router and refresh whatever
   * persisted startup observation the implementation keeps. Distinct from
   * `setup`: it acquires no ports, starts no services, and takes no Scope.
   */
  readonly revalidateStartup: Effect.Effect<void, ProxyError | RouterWatcherError>;
  readonly applyRoutes: (
    routes: ReadonlyArray<RoutePlan>,
    appId: AppId,
  ) => Effect.Effect<ProxyApplyResult, ProxyApplyError>;
  readonly removeRoutes: (appId: AppId) => Effect.Effect<void, ProxyError>;
  readonly status: Effect.Effect<ProxyStatus, ProxyError>;
  readonly stop: Effect.Effect<void, ProxyError>;
}

export class RouterService extends Context.Tag("@lando/core/RouterService")<
  RouterService,
  RouterServiceShape
>() {}

export interface SshSetupOptions {
  readonly force: boolean;
}

export interface SshAgentSocket {
  readonly socketPath: string;
  readonly appId: AppId;
}

export interface SshServiceShape {
  readonly id: string;
  readonly setup: (options: SshSetupOptions) => Effect.Effect<void, SshError>;
  readonly getAgentSocket: (appId: AppId) => Effect.Effect<SshAgentSocket, SshError>;
}

export class SshService extends Context.Tag("@lando/core/SshService")<SshService, SshServiceShape>() {}

export interface HealthcheckResult {
  readonly healthy: boolean;
  readonly service: ServiceName;
  readonly attempts: number;
  readonly lastStatus?: string;
}

export type HealthcheckRunError = HealthcheckTimeoutError | HealthcheckError;

export interface HealthcheckRunnerShape {
  readonly id: string;
  readonly run: (
    plan: HealthcheckPlan,
    appId: AppId,
    service: ServiceName,
  ) => Effect.Effect<HealthcheckResult, HealthcheckRunError>;
}

export class HealthcheckRunner extends Context.Tag("@lando/core/HealthcheckRunner")<
  HealthcheckRunner,
  HealthcheckRunnerShape
>() {}

export interface ScanEndpoint {
  readonly service: ServiceName;
  readonly url: string;
  readonly reachable: boolean;
  readonly statusCode?: number;
  /**
   * Probe-primitive verdict for this URL: `green` (responded with an accepted
   * status), `yellow` (responded, but outside the accepted set), or `red` (no
   * HTTP response). Populated by probe-backed scanners.
   */
  readonly outcome?: ProbeOutcome;
  /**
   * Optional structured detail for non-`green` verdicts (e.g. the last
   * transport error or `HTTP <code>`). Scanners MUST redact this through the
   * canonical redaction primitive before returning it.
   */
  readonly detail?: string;
}

export interface ScanResult {
  readonly appId: AppId;
  readonly endpoints: ReadonlyArray<ScanEndpoint>;
}

export interface PortCollision {
  readonly port: number;
  readonly apps: ReadonlyArray<{ readonly appId: AppId; readonly service: ServiceName }>;
}

export interface UrlScannerShape {
  readonly id: string;
  /**
   * Per-service settings come from options.plan.services[name].scanner.
   * Omitting the plan scans with the scanner's own defaults.
   * When `urls` is provided, those host-facing URLs are probed instead of
   * rediscovering endpoints from the captured provider.
   */
  readonly scan: (
    appId: AppId,
    options?: {
      readonly plan?: AppPlan;
      readonly urls?: ReadonlyArray<{ readonly service: ServiceName; readonly url: string }>;
    },
  ) => Effect.Effect<ScanResult, ScannerError>;
  readonly detectCollisions: (
    appIds: ReadonlyArray<AppId>,
  ) => Effect.Effect<ReadonlyArray<PortCollision>, ScannerError | PortCollisionError>;
}

export class UrlScanner extends Context.Tag("@lando/core/UrlScanner")<UrlScanner, UrlScannerShape>() {}

/**
 * `HostProxyService` resolves `*.<base-domain>` (default `lndo.site`) to a
 * loopback address so users do not have to edit `/etc/hosts` themselves.
 *
 * Default platform behavior:
 * - macOS: write `/etc/resolver/<base-domain>` (no `/etc/hosts` edit)
 * - Linux: write `/etc/hosts` block or `systemd-resolved` drop-in
 * - Windows: write the HOSTS file
 *
 * Privileged operations happen at `lando setup` time only (gated behind a
 * sudo/UAC prompt). They MUST NOT run inline during `lando start`.
 *
 * Users who manage their own DNS can opt out by running
 * `lando setup --host-proxy=none`, which selects the `none` mode and reports
 * an inactive `HostProxyStatus`.
 */
export type HostProxyMode = "auto" | "none";

export type HostProxyMechanism = "etc-hosts" | "etc-resolver" | "hosts-file" | "skipped" | "none";

export interface HostProxySetupOptions {
  readonly mode: HostProxyMode;
  readonly baseDomain?: string;
  readonly loopback?: string;
  readonly force?: boolean;
}

export interface HostProxyStatus {
  readonly active: boolean;
  readonly mode: HostProxyMode;
  readonly mechanism: HostProxyMechanism;
  readonly baseDomain: string;
  readonly loopback: string;
}

export interface HostProxyServiceShape {
  readonly id: string;
  readonly setup: (options: HostProxySetupOptions) => Effect.Effect<void, HostProxyError>;
  readonly status: () => Effect.Effect<HostProxyStatus, HostProxyError>;
  readonly teardown: () => Effect.Effect<void, HostProxyError>;
}

export class HostProxyService extends Context.Tag("@lando/core/HostProxyService")<
  HostProxyService,
  HostProxyServiceShape
>() {}

export class PluginSource extends Context.Tag("@lando/core/PluginSource")<
  PluginSource,
  {
    readonly id: string;
  }
>() {}

export class UpdateService extends Context.Tag("@lando/core/UpdateService")<
  UpdateService,
  {
    readonly id: string;
  }
>() {}

/**
 * SecretStore resolves `${secret:...}` references in Landofiles.
 *
 * Default: env-var store. Pluggable via the `secretStores:` contribution
 * surface (Vault, 1Password CLI, AWS SM, …). `get` fails with
 * `SecretNotFoundError` when absent, `SecretReferenceInvalidError` for invalid
 * references, or `SecretStoreUnavailableError` for backend failures. `has`
 * propagates unavailability rather than reporting absence. `list` is total;
 * CLI stores list references resolved in this process. Values MUST be redacted from log/event output
 * (see `@lando/sdk/secrets`).
 */
export interface SecretStoreShape {
  readonly id: string;
  readonly schemes?: ReadonlyArray<string>;
  readonly get: (secret: string) => Effect.Effect<string, SecretStoreError>;
  readonly has: (secret: string) => Effect.Effect<boolean, SecretStoreUnavailableError>;
  readonly list: Effect.Effect<ReadonlyArray<string>>;
}

export class SecretStore extends Context.Tag("@lando/core/SecretStore")<SecretStore, SecretStoreShape>() {}
