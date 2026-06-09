import { Context, type Effect } from "effect";

import type {
  CaError,
  HealthcheckError,
  HealthcheckTimeoutError,
  HostProxyError,
  PortCollisionError,
  ProxyError,
  ScannerError,
  SecretNotFoundError,
  SshError,
} from "../errors/index.ts";
import type { AppId, HealthcheckPlan, RoutePlan, ServiceName } from "../schema/index.ts";
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

export interface ProxyServiceShape {
  readonly id: string;
  readonly setup: () => Effect.Effect<void, ProxyError>;
  readonly applyRoutes: (routes: ReadonlyArray<RoutePlan>, appId: AppId) => Effect.Effect<void, ProxyError>;
  readonly removeRoutes: (appId: AppId) => Effect.Effect<void, ProxyError>;
}

export class ProxyService extends Context.Tag("@lando/core/ProxyService")<
  ProxyService,
  ProxyServiceShape
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
  readonly scan: (appId: AppId) => Effect.Effect<ScanResult, ScannerError>;
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

/**
 * PluginSource — resolve and fetch a plugin spec.
 */
export class PluginSource extends Context.Tag("@lando/core/PluginSource")<
  PluginSource,
  {
    readonly id: string;
  }
>() {}

/**
 * UpdateService — check/apply updates to core and plugins.
 */
export class UpdateService extends Context.Tag("@lando/core/UpdateService")<
  UpdateService,
  {
    readonly id: string;
  }
>() {}

/**
 * SecretStore — resolve `${secret:...}` references in Landofiles.
 *
 * Default: env-var store. Pluggable via the `secretStores:` contribution
 * surface (Vault, 1Password CLI, AWS SM, …). `get` fails with
 * `SecretNotFoundError` (carrying the secret id) when a secret is absent; `has`
 * and `list` are total. Resolved values MUST be redacted from log/event output
 * (see `@lando/sdk/secrets`).
 */
export interface SecretStoreShape {
  readonly id: string;
  readonly get: (secret: string) => Effect.Effect<string, SecretNotFoundError>;
  readonly has: (secret: string) => Effect.Effect<boolean>;
  readonly list: Effect.Effect<ReadonlyArray<string>>;
}

export class SecretStore extends Context.Tag("@lando/core/SecretStore")<SecretStore, SecretStoreShape>() {}
