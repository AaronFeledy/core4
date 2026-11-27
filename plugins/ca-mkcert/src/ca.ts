/**
 * mkcert-backed `CertificateAuthority`.
 *
 * `setup` provisions the pinned mkcert binary through `Downloader`, creates the
 * local root when `CAROOT` has none, and installs that root into the host trust
 * stores unless the caller opts out. Trusting the root in the system store is a
 * host change that `planHostChanges` proposes read-only and `setup` applies only
 * when the run approved it (`system-store-change.ts`): Lando pipes the verified
 * root to fixed root commands, so the downloaded binary never runs as root, and
 * outside Windows mkcert never runs `-install` at all.
 *
 * Every trust store the authority manages (the system store, each Linux
 * browser NSS database, each Homebrew CA bundle, and the Windows store under
 * WSL) is reported as a row. `setup` inspects them before and after installing
 * and marks the ones it took from untrusted to trusted; a store it could not
 * repair is reported untrusted, not failed. `trustStores` only inspects. The
 * system row is a fresh read, never Bun's per-process snapshot that
 * `root.trusted` uses, so setup can verify its own install. Lando writes the
 * browser databases as the user so it can report each one, and mkcert's Java
 * keystore install is not used.
 *
 * Any issuing mkcert run creates a root when `CAROOT` has none, without
 * locking, and every Lando data root on a host shares one `CAROOT`. Only
 * `setup` creates the root, under an advisory lock inside `CAROOT`; `root` and
 * `issueCert` check for it first and never create one. Issued pairs are
 * written to a private temporary directory, read back, and the directory is
 * removed whether issuance succeeds, fails, or is interrupted: the authority
 * keeps no copy.
 */

import { existsSync } from "node:fs";

import { mapFailures } from "@lando/sdk/command-result";
import { CaError } from "@lando/sdk/errors";
import type { CaSetupOptions, CertificateAuthorityShape, ProcessRunner } from "@lando/sdk/services";
import { CertificateAuthority, Downloader } from "@lando/sdk/services";
import { type ToolError, resolveHostKey } from "@lando/sdk/tool-provisioning";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { type Context, Effect } from "effect";

import type { HostEnv } from "./homebrew-trust.ts";
import { hostTrustsPem } from "./host-trust.ts";
import { makeIssueCert, makeIssueInto } from "./issuance.ts";
import { CA_ID, type MkcertContext, caError, makeRunMkcert } from "./mkcert-command.ts";
import { MKCERT_TOOL_VERSION, mkcertInstallPath, provisionMkcert } from "./provision.ts";
import { makeMkcertRoot } from "./root.ts";
import { makeSystemStoreChange } from "./system-store-change.ts";
import { TRUST_SYSTEM_STORE } from "./system-store-declaration.ts";
import { makeTrustStores, markChanges } from "./trust-stores.ts";
import { WSL_WINDOWS_TRUST_PATHS, type WindowsTrustPaths } from "./windows-trust.ts";

export { CA_ID } from "./mkcert-command.ts";

export interface MkcertCertificateAuthorityOptions {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly downloader: Context.Service.Shape<typeof Downloader>;
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly privateFileAccess: PrivateFileAccess;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
  /** Environment used to find Homebrew, browser databases and their tools; defaults to `process.env`. */
  readonly env?: HostEnv | undefined;
  /** Whether the system store this process loaded holds a PEM; defaults to Bun's system snapshot. */
  readonly hostTrustsPem?: ((pem: string) => boolean) | undefined;
  /** Linux system bundle candidates for the fresh trust check; defaults to the distro paths. */
  readonly linuxSystemBundles?: ReadonlyArray<string> | undefined;
  /** WSL interop markers and the `certutil.exe` fallback; defaults to the WSL paths. */
  readonly windowsTrustPaths?: WindowsTrustPaths | undefined;
  /** Whether a host path exists, for finding the Linux anchor store; defaults to the real host. */
  readonly exists?: ((path: string) => boolean) | undefined;
}

export const makeMkcertCertificateAuthority = (
  options: MkcertCertificateAuthorityOptions,
): CertificateAuthorityShape => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const binary = mkcertInstallPath(options.binDir, platform);

  const runMkcert = makeRunMkcert(options.processRunner, binary);
  const context: MkcertContext = {
    binDir: options.binDir,
    platform,
    arch,
    binary,
    privateFileAccess: options.privateFileAccess,
    runMkcert,
  };
  const issueInto = makeIssueInto(context);
  const env = options.env ?? process.env;
  const stores = makeTrustStores({
    processRunner: options.processRunner,
    env,
    platform,
    linuxSystemBundles: options.linuxSystemBundles,
    windowsPaths: options.windowsTrustPaths ?? WSL_WINDOWS_TRUST_PATHS,
  });
  const { caRoot, currentRoot, ensureRoot, readRoot } = makeMkcertRoot(
    context,
    issueInto,
    options.hostTrustsPem ?? hostTrustsPem,
  );

  const provisionError = (cause: ToolError): CaError =>
    cause._tag === "ToolManifestError"
      ? caError(
          `mkcert ${MKCERT_TOOL_VERSION} does not publish a binary for this host (${resolveHostKey(platform, arch)}). Install mkcert manually, or contribute a CertificateAuthority plugin for this platform.`,
          { cause },
        )
      : new CaError({
          message: cause.message,
          caId: CA_ID,
          cause,
          remediation: `${cause.remediation} Then run \`lando setup\`.`,
        });

  // CertificateAuthorityShape has no Effect requirements channel; inject Downloader here.
  const provision = (force: boolean): Effect.Effect<void, CaError> =>
    Effect.scoped(
      provisionMkcert({
        binDir: options.binDir,
        toolDownloadsDir: options.toolDownloadsDir,
        platform,
        arch,
        force,
      }),
    ).pipe(Effect.provideService(Downloader, options.downloader), mapFailures(provisionError));

  const systemStore = makeSystemStoreChange({
    platform,
    env,
    binary,
    exists: options.exists ?? existsSync,
    readRoot,
    inspect: stores.inspectSystem,
    ensuredRoot: Effect.gen(function* () {
      const caroot = yield* caRoot;
      return { caroot, root: yield* ensureRoot(caroot) };
    }),
  });

  /** Apply the approved system-store change; a stale one leaves the store untrusted, which setup reports. */
  const trustSystemStore = (hostChanges: CaSetupOptions["hostChanges"]) =>
    hostChanges?.approved(TRUST_SYSTEM_STORE) === undefined
      ? Effect.void
      : hostChanges.apply(TRUST_SYSTEM_STORE).pipe(
          Effect.asVoid,
          Effect.catchTag("HostChangeStaleError", () => Effect.void),
        );

  const issueCert = makeIssueCert(currentRoot, issueInto);

  return CertificateAuthority.of({
    id: CA_ID,
    planHostChanges: systemStore.plan().pipe(Effect.withSpan("CertificateAuthority.planHostChanges")),
    setup: Effect.fn("CertificateAuthority.setup")(function* (setupOptions: CaSetupOptions) {
      yield* provision(setupOptions.force);
      const caroot = yield* caRoot;
      const root = yield* ensureRoot(caroot);
      const before = yield* stores.snapshot(caroot, root);
      if (setupOptions.skipTrustInstall === true) {
        return { trustStores: markChanges(before.rows, before.rows) };
      }
      // A system store that already trusts the root needs no change, so reruns never ask for sudo.
      if (before.system.state !== "trusted") yield* trustSystemStore(setupOptions.hostChanges);
      return { trustStores: markChanges(before.rows, yield* stores.repair(caroot, root, before)) };
    }),
    root: currentRoot.pipe(
      Effect.map(({ root }) => root),
      Effect.withSpan("CertificateAuthority.root"),
    ),
    trustStores: currentRoot.pipe(
      Effect.flatMap(({ caroot, root }) => stores.inspect(caroot, root.certificate)),
      Effect.withSpan("CertificateAuthority.trustStores"),
    ),
    issueCert,
  });
};
