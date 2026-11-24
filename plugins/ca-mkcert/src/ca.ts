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
 * Every trust store the authority manages (the system store, then each
 * Homebrew CA bundle) is reported as a row. `setup` inspects them before and
 * after installing and marks the ones it made trust the root; a store it
 * could not repair is reported untrusted, not failed. `trustStores` only
 * inspects. The system row is a fresh read, never Bun's per-process snapshot
 * that `root.trusted` uses, so setup can verify its own install.
 *
 * Any issuing mkcert run creates a root when `CAROOT` has none, without
 * locking, and every Lando data root on a host shares one `CAROOT`. Only
 * `setup` creates the root, under an advisory lock inside `CAROOT`; `root` and
 * `issueCert` check for it first and never create one. Issued pairs are
 * written to a private temporary directory, read back, and the directory is
 * removed whether issuance succeeds, fails, or is interrupted: the authority
 * keeps no copy.
 */

import { mapFailures } from "@lando/sdk/command-result";
import { CaError } from "@lando/sdk/errors";
import type { TrustStoreChange, TrustStoreStatus } from "@lando/sdk/schema";
import type {
  CaSetupOptions,
  CertificateAuthorityShape,
  ProcessResult,
  ProcessRunner,
} from "@lando/sdk/services";
import { CertificateAuthority, Downloader } from "@lando/sdk/services";
import { type ToolError, resolveHostKey } from "@lando/sdk/tool-provisioning";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { type Context, Effect } from "effect";

import { type HostEnv, makeHomebrewTrust } from "./homebrew-trust.ts";
import { hostTrustsPem } from "./host-trust.ts";
import { makeIssueCert, makeIssueInto } from "./issuance.ts";
import { CA_ID, type MkcertContext, caError, failureDetail, makeRunMkcert } from "./mkcert-command.ts";
import { MKCERT_TOOL_VERSION, mkcertInstallPath, provisionMkcert } from "./provision.ts";
import { makeMkcertRoot } from "./root.ts";
import { makeSystemTrust } from "./system-trust.ts";

export { CA_ID } from "./mkcert-command.ts";

const storeKey = ({ id, location }: TrustStoreStatus): string => JSON.stringify([id, location ?? null]);

/** `after`, each row marked changed when setup took it from not trusted to trusted. */
const markChanges = (
  before: ReadonlyArray<TrustStoreStatus>,
  after: ReadonlyArray<TrustStoreStatus>,
): ReadonlyArray<TrustStoreChange> => {
  const trustedBefore = new Set(before.filter(({ state }) => state === "trusted").map(storeKey));
  return after.map((row) => ({
    ...row,
    changed: row.state === "trusted" && !trustedBefore.has(storeKey(row)),
  }));
};

export interface MkcertCertificateAuthorityOptions {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly downloader: Context.Service.Shape<typeof Downloader>;
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly privateFileAccess: PrivateFileAccess;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
  /** Environment used to find Homebrew; defaults to `process.env`. */
  readonly env?: HostEnv | undefined;
  /** Whether the system store this process loaded holds a PEM; defaults to Bun's system snapshot. */
  readonly hostTrustsPem?: ((pem: string) => boolean) | undefined;
  /** Linux system bundle candidates for the fresh trust check; defaults to the distro paths. */
  readonly linuxSystemBundles?: ReadonlyArray<string> | undefined;
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
  const homebrew = makeHomebrewTrust({
    processRunner: options.processRunner,
    env: options.env ?? process.env,
    platform,
  });
  const systemTrust = makeSystemTrust({
    processRunner: options.processRunner,
    platform,
    linuxBundles: options.linuxSystemBundles,
  });
  const { caRoot, currentRoot, ensureRoot } = makeMkcertRoot(
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

  /** Every managed store, system first, in a stable order. Reads only. */
  const inspect = Effect.fnUntraced(function* (caroot: string, root: string) {
    const system = yield* systemTrust.inspect(caroot, root);
    return [system, ...(yield* homebrew.inspect(root))];
  });

  return CertificateAuthority.of({
    id: CA_ID,
    setup: Effect.fn("CertificateAuthority.setup")(function* (setupOptions: CaSetupOptions) {
      yield* provision(setupOptions.force);
      const caroot = yield* caRoot;
      const root = yield* ensureRoot(caroot);
      const before = yield* inspect(caroot, root);
      if (setupOptions.skipTrustInstall === true) return { trustStores: markChanges(before, before) };
      yield* installTrust(caroot, setupOptions.privilege);
      // mkcert can exit 0 without the system store trusting the root; that is reported, not fatal.
      const system = yield* systemTrust.inspect(caroot, root);
      const homebrewRows = yield* homebrew.refresh(root, system.state === "trusted");
      return { trustStores: markChanges(before, [system, ...homebrewRows]) };
    }),
    root: currentRoot.pipe(
      Effect.map(({ root }) => root),
      Effect.withSpan("CertificateAuthority.root"),
    ),
    trustStores: currentRoot.pipe(
      Effect.flatMap(({ caroot, root }) => inspect(caroot, root.certificate)),
      Effect.withSpan("CertificateAuthority.trustStores"),
    ),
    issueCert,
  });
};
