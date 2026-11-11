/** Issuing mkcert leaves into a private temporary directory that never outlives the call. */
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Redacted, Schema } from "effect";

import { mapFailures } from "@lando/sdk/command-result";
import { CaError } from "@lando/sdk/errors";
import { CertificateSpec } from "@lando/sdk/schema";
import type { CaRootCertificate, IssuedCertificate } from "@lando/sdk/services";

import { CA_ID, type MkcertContext, caError, failureDetail } from "./mkcert-command.ts";

/** Run mkcert for `names` into a private temporary directory that is removed afterwards. */
export const makeIssueInto =
  ({ privateFileAccess, runMkcert }: MkcertContext) =>
  <A>(
    caroot: string,
    names: ReadonlyArray<string>,
    read: (files: { readonly certificate: string; readonly privateKey: string }) => Promise<A>,
  ): Effect.Effect<A, CaError> =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const dir = await mkdtemp(join(tmpdir(), "lando-mkcert-"));
          await chmod(dir, 0o700);
          await privateFileAccess.enforce(dir);
          return dir;
        },
        catch: (cause) => caError("Failed to create a private temporary directory for mkcert.", { cause }),
      }),
      (dir) =>
        Effect.gen(function* () {
          const files = { certificate: join(dir, "cert.pem"), privateKey: join(dir, "key.pem") };
          const issued = yield* runMkcert(
            ["-cert-file", files.certificate, "-key-file", files.privateKey, "--", ...names],
            { CAROOT: caroot },
          );
          if (issued.exitCode !== 0) {
            return yield* Effect.fail(
              caError(
                `mkcert could not issue a certificate for ${names.join(", ")}: ${failureDetail(issued)}.`,
              ),
            );
          }
          return yield* Effect.tryPromise({
            try: () => read(files),
            catch: (cause) => caError(`Failed to read the certificate mkcert issued in ${dir}.`, { cause }),
          });
        }),
      (dir) =>
        Effect.tryPromise(() => rm(dir, { recursive: true, force: true })).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`Unable to remove mkcert temporary directory ${dir}: ${cause.message}`),
          ),
        ),
    );

export type IssueInto = ReturnType<typeof makeIssueInto>;

export const makeIssueCert = (
  currentRoot: Effect.Effect<{ readonly caroot: string; readonly root: CaRootCertificate }, CaError>,
  issueInto: IssueInto,
) =>
  Effect.fn("CertificateAuthority.issueCert")(function* (
    spec: CertificateSpec,
  ): Effect.fn.Return<IssuedCertificate, CaError> {
    yield* Schema.decodeUnknownEffect(CertificateSpec)(spec).pipe(
      mapFailures(
        (cause) =>
          new CaError({
            message: `Certificate request names are invalid: ${cause.message}`,
            caId: CA_ID,
            cause,
            remediation:
              "Request DNS names, leftmost *. wildcards, or IP addresses. Report the component that requested this certificate.",
          }),
      ),
    );
    const { caroot, root } = yield* currentRoot;
    return yield* issueInto(caroot, [...new Set([...spec.sans, spec.cn])], async (files) => ({
      certificate: await readFile(files.certificate, "utf8"),
      privateKey: Redacted.make(await readFile(files.privateKey, "utf8")),
      root,
    }));
  });
