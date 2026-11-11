/**
 * mkcert-backed `CertificateAuthority`.
 *
 * `setup` provisions the pinned mkcert binary through `Downloader`, creates the
 * local root when `CAROOT` has none, and installs that root into the host trust
 * stores unless the caller opts out. mkcert elevates its own trust-store writes
 * on Unix, so elevation through `PrivilegeService` is the fallback for hosts
 * where the unelevated attempt fails; the resolved `CAROOT` is passed
 * explicitly on that retry because elevation does not preserve the invoking
 * user's environment.
 *
 * Any issuing mkcert run creates a root when `CAROOT` has none, without
 * locking, and every Lando data root on a host shares one `CAROOT`. Only
 * `setup` creates the root, under an advisory lock inside `CAROOT`; `root` and
 * `issueCert` check for it first and never create one. Issued pairs are
 * written to a private temporary directory, read back, and the directory is
 * removed whether issuance succeeds, fails, or is interrupted: the authority
 * keeps no copy.
 */
import { type Context, Effect } from "effect";

import { mapFailures } from "@lando/sdk/command-result";
import { CaError } from "@lando/sdk/errors";
import type {
  CaSetupOptions,
  CertificateAuthorityShape,
  ProcessResult,
  ProcessRunner,
} from "@lando/sdk/services";
import { CertificateAuthority, Downloader } from "@lando/sdk/services";
import { type ToolError, resolveHostKey } from "@lando/sdk/tool-provisioning";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";

import { makeIssueCert, makeIssueInto } from "./issuance.ts";
import { CA_ID, type MkcertContext, caError, failureDetail, makeRunMkcert } from "./mkcert-command.ts";
import { MKCERT_TOOL_VERSION, mkcertInstallPath, provisionMkcert } from "./provision.ts";
import { makeMkcertRoot } from "./root.ts";

export { CA_ID } from "./mkcert-command.ts";

export interface MkcertCertificateAuthorityOptions {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly downloader: Context.Service.Shape<typeof Downloader>;
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly privateFileAccess: PrivateFileAccess;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
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
  const { caRoot, currentRoot, ensureRoot } = makeMkcertRoot(context, issueInto);

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

  const trustInstallError = (result: ProcessResult): CaError =>
    caError(
      `mkcert could not install the local CA into the host trust store: ${failureDetail(result)}. Re-run \`lando setup\` with sufficient privileges, or run \`lando setup --skip-install-ca\` to skip host trust installation.`,
    );

  const installTrust = Effect.fn("CertificateAuthority.installTrust")(function* (
    root: string,
    privilege: CaSetupOptions["privilege"],
  ): Effect.fn.Return<void, CaError> {
    const attempt = yield* runMkcert(["-install"], { CAROOT: root });
    if (attempt.exitCode === 0) return;
    if (privilege === undefined) return yield* Effect.fail(trustInstallError(attempt));

    const elevated = yield* privilege.elevate(["env", `CAROOT=${root}`, binary, "-install"]);
    if (elevated.exitCode !== 0) return yield* Effect.fail(trustInstallError(elevated));
  });

  const issueCert = makeIssueCert(currentRoot, issueInto);

  return CertificateAuthority.of({
    id: CA_ID,
    setup: Effect.fn("CertificateAuthority.setup")(function* (setupOptions: CaSetupOptions) {
      yield* provision(setupOptions.force);
      const caroot = yield* caRoot;
      yield* ensureRoot(caroot);
      if (setupOptions.skipTrustInstall === true) return;
      yield* installTrust(caroot, setupOptions.privilege);
    }),
    root: Effect.map(currentRoot, ({ root }) => root).pipe(Effect.withSpan("CertificateAuthority.root")),
    issueCert,
  });
};
