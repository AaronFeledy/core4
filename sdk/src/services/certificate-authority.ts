import { Context, type Effect, type Redacted } from "effect";

import type { CaError } from "../errors/index.ts";
import type { CertificateSpec, CommandWarning } from "../schema/index.ts";
import type { PrivilegeService } from "./process.ts";

export interface CaSetupOptions {
  readonly force: boolean;
  readonly skipTrustInstall?: boolean;
  readonly privilege?: Context.Service.Shape<typeof PrivilegeService>;
}

export type { CertificateSpec } from "../schema/index.ts";

/** A CA bundle a tool keeps apart from the host trust store, such as Homebrew's. */
export interface CaTrustBundle {
  /** Who maintains the bundle, as people know it, e.g. `Homebrew`. */
  readonly owner: string;
  /** Absolute path of the bundle file. */
  readonly path: string;
}

export interface CaSetupResult {
  /** Bundles setup refreshed so the tools that read them trust the root. */
  readonly refreshedBundles: ReadonlyArray<CaTrustBundle>;
  /**
   * Trust setup could not finish. The authority still issues certificates and Lando still trusts
   * its root.
   */
  readonly warnings: ReadonlyArray<CommandWarning>;
}

export interface CaRootCertificate {
  /** PEM of the root that signs issued leaves. */
  readonly certificate: string;
  /**
   * Whether this root is already in the host trust store.
   * Reporting it must not install trust.
   */
  readonly trusted: boolean;
  /**
   * Bundles that should include this root but do not yet; `setup` refreshes them. Reported only
   * when `trusted` is true, because a bundle rebuilt from an untrusting store would not help.
   * Reading it is a read, never an install.
   */
  readonly staleBundles?: ReadonlyArray<CaTrustBundle>;
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
    readonly setup: (options: CaSetupOptions) => Effect.Effect<CaSetupResult, CaError>;
    /**
     * The current signing root. Fails with remediation when the authority is not
     * set up or has no root yet. Must not create a root, install host trust,
     * download a tool, or prompt.
     */
    readonly root: Effect.Effect<CaRootCertificate, CaError>;
    /** Issue fresh material. The authority maintains no persistent leaf store. */
    readonly issueCert: (spec: CertificateSpec) => Effect.Effect<IssuedCertificate, CaError>;
  }
>()("@lando/core/CertificateAuthority") {}

export type CertificateAuthorityShape = CertificateAuthority["Service"];
