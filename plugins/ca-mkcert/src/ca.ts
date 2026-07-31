/**
 * mkcert-backed `CertificateAuthority`.
 *
 * `setup` provisions the pinned mkcert binary through `Downloader` and installs
 * the local root CA into the host trust stores unless the caller opts out.
 * mkcert elevates its own trust-store writes on Unix, so elevation through
 * `PrivilegeService` is the fallback for hosts where the unelevated attempt
 * fails; the resolved `CAROOT` is passed explicitly on that retry because
 * elevation does not preserve the invoking user's environment.
 *
 * `issueCert` drives the installed binary with explicit `-cert-file` /
 * `-key-file` paths under Lando's certs directory and reports the root CA from
 * `mkcert -CAROOT`.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { type Context, Effect } from "effect";

import { CaError } from "@lando/sdk/errors";
import type {
  CaSetupOptions,
  CertificateAuthorityShape,
  CertificateResult,
  CertificateSpec,
  ProcessResult,
  ProcessRunner,
} from "@lando/sdk/services";
import { Downloader } from "@lando/sdk/services";
import { type ToolError, resolveHostKey } from "@lando/sdk/tool-provisioning";

import {
  MKCERT_TOOL_VERSION,
  mkcertInstallPath,
  provisionMkcert,
  readInstalledMkcertStatus,
} from "./provision.ts";

export const CA_ID = "mkcert" as const;

const SETUP_REMEDIATION = "Run `lando setup` to download mkcert and install the local CA.";

export interface MkcertCertificateAuthorityOptions {
  readonly binDir: string;
  readonly certsDir: string;
  readonly toolDownloadsDir: string;
  readonly downloader: Context.Tag.Service<typeof Downloader>;
  readonly processRunner: Context.Tag.Service<typeof ProcessRunner>;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
}

const caError = (message: string, cause?: unknown): CaError =>
  new CaError({ message, caId: CA_ID, ...(cause === undefined ? {} : { cause }) });

/**
 * Map a certificate common name onto a file name contained in the certs
 * directory, following mkcert's own wildcard/colon conventions.
 */
export const mkcertLeafCertificateName = (cn: string): string => {
  const mapped = cn
    .replaceAll("*", "_wildcard")
    .replaceAll(":", "_")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return mapped.length === 0 || /^\.+$/u.test(mapped) ? "certificate" : mapped;
};

const failureDetail = (result: ProcessResult): string => {
  const detail = (result.stderr.trim().length > 0 ? result.stderr : result.stdout).trim();
  return detail.length === 0 ? `exit code ${result.exitCode}` : detail;
};

export const makeMkcertCertificateAuthority = (
  options: MkcertCertificateAuthorityOptions,
): CertificateAuthorityShape => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const binary = mkcertInstallPath(options.binDir, platform);

  const runMkcert = (
    args: ReadonlyArray<string>,
    env?: Readonly<Record<string, string>>,
  ): Effect.Effect<ProcessResult, CaError> =>
    options.processRunner
      .run({ cmd: binary, args, ...(env === undefined ? {} : { env }) })
      .pipe(Effect.mapError((cause) => caError(`Failed to run mkcert: ${cause.message}`, cause)));

  const caRoot: Effect.Effect<string, CaError> = Effect.gen(function* () {
    const result = yield* runMkcert(["-CAROOT"]);
    const root = result.stdout.trim();
    if (result.exitCode !== 0 || root.length === 0) {
      return yield* Effect.fail(
        caError(`mkcert could not report its CA root: ${failureDetail(result)}. ${SETUP_REMEDIATION}`),
      );
    }
    return root;
  });

  const provisionError = (cause: ToolError): CaError =>
    cause._tag === "ToolManifestError"
      ? caError(
          `mkcert ${MKCERT_TOOL_VERSION} does not publish a binary for this host (${resolveHostKey(platform, arch)}). Install mkcert manually, or contribute a CertificateAuthority plugin for this platform.`,
          cause,
        )
      : caError(
          `Failed to provision mkcert ${MKCERT_TOOL_VERSION} for ${resolveHostKey(platform, arch)}: ${cause.message}. ${SETUP_REMEDIATION}`,
          cause,
        );

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
    ).pipe(Effect.provideService(Downloader, options.downloader), Effect.mapError(provisionError));

  const trustInstallError = (result: ProcessResult): CaError =>
    caError(
      `mkcert could not install the local CA into the host trust store: ${failureDetail(result)}. Re-run \`lando setup\` with sufficient privileges, or run \`lando setup --skip-install-ca\` to skip host trust installation.`,
    );

  const installTrust = (privilege: CaSetupOptions["privilege"]): Effect.Effect<void, CaError> =>
    Effect.gen(function* () {
      const root = yield* caRoot;
      const attempt = yield* runMkcert(["-install"], { CAROOT: root });
      if (attempt.exitCode === 0) return;
      if (privilege === undefined) return yield* Effect.fail(trustInstallError(attempt));

      const elevated = yield* privilege.elevate(["env", `CAROOT=${root}`, binary, "-install"]);
      if (elevated.exitCode !== 0) return yield* Effect.fail(trustInstallError(elevated));
    });

  const issueCert = (spec: CertificateSpec): Effect.Effect<CertificateResult, CaError> =>
    Effect.gen(function* () {
      const installed = yield* Effect.promise(() =>
        readInstalledMkcertStatus(options.binDir, platform, arch),
      );
      if (!installed.isCurrent) {
        return yield* Effect.fail(
          caError(`mkcert ${MKCERT_TOOL_VERSION} is not installed at ${binary}. ${SETUP_REMEDIATION}`),
        );
      }

      yield* Effect.tryPromise({
        try: () => mkdir(options.certsDir, { recursive: true }),
        catch: (cause) => caError(`Failed to create the certificate directory ${options.certsDir}.`, cause),
      });

      const root = yield* caRoot;
      const name = mkcertLeafCertificateName(spec.cn);
      const certPath = join(options.certsDir, `${name}.pem`);
      const keyPath = join(options.certsDir, `${name}-key.pem`);
      const names = [...new Set([...spec.sans, spec.cn])];
      const result = yield* runMkcert(["-cert-file", certPath, "-key-file", keyPath, "--", ...names], {
        CAROOT: root,
      });
      if (result.exitCode !== 0) {
        return yield* Effect.fail(
          caError(`mkcert could not issue a certificate for ${spec.cn}: ${failureDetail(result)}.`),
        );
      }

      return { certPath, keyPath, caPath: join(root, "rootCA.pem") };
    });

  return {
    id: CA_ID,
    setup: (setupOptions) =>
      Effect.gen(function* () {
        yield* provision(setupOptions.force);
        if (setupOptions.skipTrustInstall === true) return;
        yield* installTrust(setupOptions.privilege);
      }),
    issueCert,
  };
};
