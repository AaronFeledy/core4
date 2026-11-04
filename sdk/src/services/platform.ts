import { Context, type Effect, type Scope } from "effect";
import type { AppId } from "../schema/primitives.ts";

import type {
  AppPlacementError,
  CaError,
  HealthcheckError,
  HealthcheckTargetUnsupportedError,
  HealthcheckTimeoutError,
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
  AppPlan,
  EndpointRef,
  HealthcheckPlan,
  ProxyApplyResult,
  ProxyCapabilities,
  ProxyConfig,
  ProxyStatus,
  RouteEvidence,
  RoutePlan,
  ScanVerdict,
  ServiceName,
} from "../schema/index.ts";
import type { PrivilegeService } from "./process.ts";

export interface CaSetupOptions {
  readonly force: boolean;
  readonly skipTrustInstall?: boolean;
  readonly privilege?: Context.Service.Shape<typeof PrivilegeService>;
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

export class CertificateAuthority extends Context.Service<
  CertificateAuthority,
  {
    readonly id: string;
    readonly setup: (options: CaSetupOptions) => Effect.Effect<void, CaError>;
    readonly issueCert: (spec: CertificateSpec) => Effect.Effect<CertificateResult, CaError>;
  }
>()("@lando/core/CertificateAuthority") {}

export type CertificateAuthorityShape = CertificateAuthority["Service"];

export class RouterService extends Context.Service<
  RouterService,
  {
    readonly id: string;
    readonly capabilities: ProxyCapabilities;
    /** Resolve and persist route publication ports before starting required global services. */
    readonly prepare?: (
      config: ProxyConfig,
    ) => Effect.Effect<
      void,
      AppPlacementError | ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch
    >;
    readonly setup: (
      config: ProxyConfig,
      options?: {
        readonly autoApprove?: boolean;
        /** Rescan host ports instead of reusing the persisted pair; set only by explicit `lando setup`. */
        readonly reacquirePorts?: boolean;
      },
    ) => Effect.Effect<
      void,
      AppPlacementError | ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch | RouterWatcherError,
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
    readonly observeRoutes: (
      app: AppId,
      requestedRoutes: ReadonlyArray<RoutePlan>,
    ) => Effect.Effect<RouteEvidence, ProxyError>;
    readonly status: Effect.Effect<ProxyStatus, ProxyError>;
    readonly stop: Effect.Effect<void, ProxyError>;
  }
>()("@lando/core/RouterService") {}

export type RouterServiceShape = RouterService["Service"];

export interface SshSetupOptions {
  readonly force: boolean;
}

export interface SshAgentSocket {
  readonly socketPath: string;
  readonly appId: AppId;
  readonly runtimeVolume?: string;
}

export class SshService extends Context.Service<
  SshService,
  {
    readonly id: string;
    readonly setup: (options: SshSetupOptions) => Effect.Effect<void, SshError>;
    readonly getAgentSocket: (appId: AppId) => Effect.Effect<SshAgentSocket, SshError>;
  }
>()("@lando/core/SshService") {}

export type SshServiceShape = SshService["Service"];

export interface HealthcheckResult {
  readonly healthy: boolean;
  readonly service: ServiceName;
  readonly attempts: number;
  readonly lastStatus?: string;
}

export type HealthcheckRunError =
  | HealthcheckTimeoutError
  | HealthcheckError
  | HealthcheckTargetUnsupportedError;

export class HealthcheckRunner extends Context.Service<
  HealthcheckRunner,
  {
    readonly id: string;
    readonly run: (
      plan: HealthcheckPlan,
      appId: AppId,
      service: ServiceName,
      appPlan?: AppPlan,
    ) => Effect.Effect<HealthcheckResult, HealthcheckRunError>;
  }
>()("@lando/core/HealthcheckRunner") {}

export type HealthcheckRunnerShape = HealthcheckRunner["Service"];

export type { ScanVerdict } from "../schema/networking.ts";

export interface ScanEndpoint {
  readonly verdict: ScanVerdict;
  readonly routerMarker?: string;
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

/** One completed probe attempt; detail is redacted by the scanner before notification. */
export interface ScanAttempt {
  readonly verdict: ScanVerdict;
  readonly willRetry?: boolean;
  readonly service: ServiceName;
  readonly url: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly outcome: ProbeOutcome;
  readonly statusCode?: number;
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

export class UrlScanner extends Context.Service<
  UrlScanner,
  {
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
        readonly urls?: ReadonlyArray<{
          readonly service: ServiceName;
          readonly url: string;
          readonly endpoint?: EndpointRef;
        }>;
        /** Observe completed attempts without affecting probe verdicts; detail is redacted. */
        readonly onAttempt?: (attempt: ScanAttempt) => Effect.Effect<void>;
      },
    ) => Effect.Effect<ScanResult, ScannerError>;
    readonly detectCollisions: (
      appIds: ReadonlyArray<AppId>,
    ) => Effect.Effect<ReadonlyArray<PortCollision>, ScannerError | PortCollisionError>;
  }
>()("@lando/core/UrlScanner") {}

export type UrlScannerShape = UrlScanner["Service"];

export class PluginSource extends Context.Service<
  PluginSource,
  {
    readonly id: string;
  }
>()("@lando/core/PluginSource") {}

export class UpdateService extends Context.Service<
  UpdateService,
  {
    readonly id: string;
  }
>()("@lando/core/UpdateService") {}

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
export class SecretStore extends Context.Service<
  SecretStore,
  {
    readonly id: string;
    readonly schemes?: ReadonlyArray<string>;
    readonly get: (secret: string) => Effect.Effect<string, SecretStoreError>;
    readonly has: (secret: string) => Effect.Effect<boolean, SecretStoreUnavailableError>;
    readonly list: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@lando/core/SecretStore") {}

export type SecretStoreShape = SecretStore["Service"];
