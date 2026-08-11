/** Update manifest signatures and artifact checksum verification. */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Effect } from "effect";

import { ProcessRunner } from "@lando/sdk/services";
import {
  UpdateChecksumSignatureVerificationError,
  UpdateChecksumVerificationError,
  UpdateSignatureVerificationError,
} from "./errors.ts";

export interface UpdateManifestSignatureInput {
  readonly manifestUrl: string;
  readonly manifestBytes: Uint8Array;
  readonly signatureUrl: string;
  readonly signatureBytes: Uint8Array;
  readonly certificateUrl: string;
  readonly certificateBytes: Uint8Array;
}

export interface UpdateChecksumSignatureInput {
  readonly checksumsUrl: string;
  readonly checksumsBytes: Uint8Array;
  readonly signatureUrl: string;
  readonly signatureBytes: Uint8Array;
  readonly certificateUrl: string;
  readonly certificateBytes: Uint8Array;
}

export type UpdateManifestSignatureVerifier = (
  input: UpdateManifestSignatureInput,
) => Effect.Effect<void, unknown, ProcessRunner>;
export type UpdateChecksumSignatureVerifier = (
  input: UpdateChecksumSignatureInput,
) => Effect.Effect<void, unknown, ProcessRunner>;

const UPDATE_COSIGN_CERTIFICATE_IDENTITY_REGEXP =
  "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$";

const verifyCosignBlob = ({
  blobBytes,
  blobFilename,
  certificateBytes,
  failureLabel,
  signatureBytes,
  workDirPrefix,
}: {
  readonly blobBytes: Uint8Array;
  readonly blobFilename: string;
  readonly certificateBytes: Uint8Array;
  readonly failureLabel: string;
  readonly signatureBytes: Uint8Array;
  readonly workDirPrefix: string;
}): Effect.Effect<void, Error, ProcessRunner> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), workDirPrefix))),
    (root) =>
      Effect.gen(function* () {
        const processRunner = yield* ProcessRunner;
        const blobPath = join(root, blobFilename);
        const signaturePath = join(root, `${blobFilename}.sig`);
        const certificatePath = join(root, `${blobFilename}.crt`);
        yield* Effect.tryPromise(() =>
          Promise.all([
            writeFile(blobPath, blobBytes),
            writeFile(signaturePath, signatureBytes),
            writeFile(certificatePath, certificateBytes),
          ]),
        );
        const result = yield* processRunner.run({
          cmd: "cosign",
          args: [
            "verify-blob",
            "--certificate-identity-regexp",
            UPDATE_COSIGN_CERTIFICATE_IDENTITY_REGEXP,
            "--certificate-oidc-issuer",
            "https://token.actions.githubusercontent.com",
            "--signature",
            signaturePath,
            "--certificate",
            certificatePath,
            blobPath,
          ],
        });
        if (result.exitCode !== 0) {
          const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 500);
          return yield* Effect.fail(
            new Error(
              `cosign verify-blob failed for ${failureLabel}${output.length === 0 ? "" : `: ${output}`}`,
            ),
          );
        }
      }),
    (root) =>
      Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(
        Effect.catchAll(() => Effect.void),
      ),
  );

export const defaultVerifyManifestSignature: UpdateManifestSignatureVerifier = ({
  certificateBytes,
  manifestBytes,
  manifestUrl,
  signatureBytes,
}) =>
  verifyCosignBlob({
    workDirPrefix: "lando-update-manifest-",
    blobFilename: "manifest.json",
    blobBytes: manifestBytes,
    signatureBytes,
    certificateBytes,
    failureLabel: manifestUrl,
  });

export const defaultVerifyChecksumSignature: UpdateChecksumSignatureVerifier = ({
  certificateBytes,
  checksumsBytes,
  checksumsUrl,
  signatureBytes,
}) =>
  verifyCosignBlob({
    workDirPrefix: "lando-update-checksums-",
    blobFilename: "SHA256SUMS",
    blobBytes: checksumsBytes,
    signatureBytes,
    certificateBytes,
    failureLabel: checksumsUrl,
  });

export const verifyManifestSignature = (
  verifier: UpdateManifestSignatureVerifier,
  input: UpdateManifestSignatureInput,
): Effect.Effect<void, UpdateSignatureVerificationError, ProcessRunner> =>
  verifier(input).pipe(
    Effect.mapError(
      (cause) =>
        new UpdateSignatureVerificationError({
          message: `Update manifest signature verification failed for ${input.manifestUrl}.`,
          manifestUrl: input.manifestUrl,
          signatureUrl: input.signatureUrl,
          cause,
        }),
    ),
  );

export const verifyChecksumSignature = (
  verifier: UpdateChecksumSignatureVerifier,
  input: UpdateChecksumSignatureInput,
): Effect.Effect<void, UpdateChecksumSignatureVerificationError, ProcessRunner> =>
  verifier(input).pipe(
    Effect.mapError(
      (cause) =>
        new UpdateChecksumSignatureVerificationError({
          message: `Update checksum signature verification failed for ${input.checksumsUrl}.`,
          checksumsUrl: input.checksumsUrl,
          signatureUrl: input.signatureUrl,
          cause,
        }),
    ),
  );

export const checksumCertificateUrlFor = (signatureUrl: string): string => {
  if (signatureUrl.endsWith(".sig")) return `${signatureUrl.slice(0, -4)}.crt`;
  return `${signatureUrl}.crt`;
};

export const artifactNameFromUrl = (url: string): string => {
  try {
    return basename(new URL(url).pathname);
  } catch {
    return basename(url);
  }
};

const normalizeChecksumPath = (path: string): string => path.replace(/^\*/u, "").replace(/^\.\//u, "");

const checksumEntryForArtifact = (checksums: string, artifact: string): string | undefined => {
  for (const line of checksums.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(?<sha>[a-fA-F0-9]{64})\s+(?<path>.+)$/u.exec(trimmed);
    if (match?.groups === undefined) continue;
    const sha = match.groups.sha;
    const path = match.groups.path;
    if (sha === undefined || path === undefined) continue;
    const entryPath = normalizeChecksumPath(path.trim());
    if (basename(entryPath) === artifact) return sha.toLowerCase();
  }
  return undefined;
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const verifyBinaryChecksum = ({
  artifact,
  binaryBytes,
  checksumsBytes,
  manifestSha256,
}: {
  readonly artifact: string;
  readonly binaryBytes: Uint8Array;
  readonly checksumsBytes: Uint8Array;
  readonly manifestSha256: string;
}): Effect.Effect<void, UpdateChecksumVerificationError> =>
  Effect.sync(() => new TextDecoder().decode(checksumsBytes)).pipe(
    Effect.flatMap((checksums) => {
      const expected = checksumEntryForArtifact(checksums, artifact);
      if (expected === undefined) {
        return Effect.fail(
          new UpdateChecksumVerificationError({
            message: `Update checksums do not contain an entry for ${artifact}.`,
            artifact,
          }),
        );
      }
      if (expected !== manifestSha256.toLowerCase()) {
        return Effect.fail(
          new UpdateChecksumVerificationError({
            message: `Update manifest checksum for ${artifact} does not match the signed checksum manifest.`,
            artifact,
            expected,
            actual: manifestSha256.toLowerCase(),
          }),
        );
      }
      const actual = sha256Hex(binaryBytes);
      return actual === expected
        ? Effect.void
        : Effect.fail(
            new UpdateChecksumVerificationError({
              message: `Downloaded update artifact ${artifact} failed checksum verification.`,
              artifact,
              expected,
              actual,
            }),
          );
    }),
  );
