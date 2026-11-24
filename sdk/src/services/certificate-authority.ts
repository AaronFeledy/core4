import { Context, type Effect, type Redacted } from "effect";

import type { CaError } from "../errors/index.ts";
import type { CertificateSpec, TrustStoreChange, TrustStoreStatus } from "../schema/index.ts";
import type { PrivilegeService } from "./process.ts";

export interface CaSetupOptions {
  readonly force: boolean;
  readonly skipTrustInstall?: boolean;
  readonly privilege?: Context.Service.Shape<typeof PrivilegeService>;
}

export type { CertificateSpec } from "../schema/index.ts";

/** What `setup` did to each host trust store the authority manages. */
export interface CaSetupReport {
  /**
   * Every managed store as setup left it. A store setup could not make trust the root is reported
   * here, not as a failure: the authority still issues certificates.
   */
  readonly trustStores: ReadonlyArray<TrustStoreChange>;
}

export interface CaRootCertificate {
  /** PEM of the root that signs issued leaves. */
  readonly certificate: string;
  /**
   * Whether the host's system trust store already holds this root: a cheap view that excludes
   * process CA overrides such as `NODE_EXTRA_CA_CERTS`. Reporting it must not install trust.
   */
  readonly trusted: boolean;
}

export interface IssuedCertificate {
  /** PEM of the issued leaf certificate. */
  readonly certificate: string;
  /** PEM of the leaf's private key. */
  readonly privateKey: Redacted.Redacted<string>;
  /** The root that signed this leaf. */
  readonly root: CaRootCertificate;
}

/**
 * Issues leaf certificates and owns host trust. Consumers keep their own copy
 * of issued material and decide when to reissue: an authority maintains no
 * persistent leaf store, and removes any temporary files it needs when
 * issuance completes, fails, or is interrupted.
 */
export class CertificateAuthority extends Context.Service<
  CertificateAuthority,
  {
    readonly id: string;
    readonly setup: (options: CaSetupOptions) => Effect.Effect<CaSetupReport, CaError>;
    /**
     * The current signing root. Fails with remediation when the authority is not
     * set up or has no root yet. Must not create a root, install host trust,
     * download a tool, or prompt.
     */
    readonly root: Effect.Effect<CaRootCertificate, CaError>;
    /**
     * Read-only inspection of every host trust store the authority manages. May run read-only
     * inspection commands; never installs, refreshes, downloads, prompts, or creates a root. Fails
     * only when the authority or its root is unavailable; a store it cannot inspect is `unknown`.
     */
    readonly trustStores: Effect.Effect<ReadonlyArray<TrustStoreStatus>, CaError>;
    /** Issue fresh material. The authority maintains no persistent leaf store. */
    readonly issueCert: (spec: CertificateSpec) => Effect.Effect<IssuedCertificate, CaError>;
  }
>()("@lando/core/CertificateAuthority") {}

export type CertificateAuthorityShape = CertificateAuthority["Service"];
