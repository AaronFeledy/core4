/**
 * Service leaf-certificate planning.
 *
 * Core owns certificate intent: it derives the SAN coverage for a service,
 * asks the active `CertificateAuthority` to issue the leaf pair, and seeds the
 * `lando.certs` feature with the resolved host paths. Custom certificate
 * material authored on the Landofile is contained to the app root and checked
 * for readability here so the feature stays a pure mount/env application.
 */
import { resolve } from "node:path";

import { type Context, Effect } from "effect";

import {
  type AmbiguousCertificateAuthoritiesError,
  LandofileValidationError,
  type NoCertificateAuthorityError,
  type PluginLoadError,
} from "@lando/sdk/errors";
import type { RouteInput, ServiceConfig } from "@lando/sdk/schema";
import type { CertificateAuthorityShape, FileSystem } from "@lando/sdk/services";

import { assertUnderRoot } from "@lando/landofile/include-guard";

const CERTS_FEATURE_ID = "lando.certs" as const;

const CA_REMEDIATION =
  "Run `lando setup` to install a certificate authority, or set certs to false or a custom certificate path.";

interface CertsFeatureConfig extends Readonly<Record<string, unknown>> {
  readonly certPath?: string;
  readonly keyPath?: string;
  readonly cn?: string;
  readonly sans?: ReadonlyArray<string>;
  readonly caId?: string;
}

interface ResolveCertsFeatureInput {
  readonly appName: string;
  readonly appRoot: string;
  readonly serviceName: string;
  readonly certs: ServiceConfig["certs"];
  readonly hostnames: ReadonlyArray<string>;
  readonly routes: ReadonlyArray<RouteInput>;
  readonly defaultRouteHostname?: string | undefined;
  readonly resolveCertificateAuthority?:
    | Effect.Effect<
        CertificateAuthorityShape,
        NoCertificateAuthorityError | AmbiguousCertificateAuthoritiesError | PluginLoadError
      >
    | undefined;
  readonly fileSystem?: Pick<Context.Tag.Service<typeof FileSystem>, "stat" | "readFile"> | undefined;
}

const validationError = (input: ResolveCertsFeatureInput, message: string): LandofileValidationError =>
  new LandofileValidationError({
    message: `services.${input.serviceName}.certs ${message}`,
    file: `${input.appRoot}/.lando.yml`,
    issues: [`services.${input.serviceName}.certs`],
  });

const internalAlias = (serviceName: string, appName: string): string => `${serviceName}.${appName}.internal`;

const certificateSans = (input: ResolveCertsFeatureInput): ReadonlyArray<string> => {
  const candidates = [
    input.serviceName,
    internalAlias(input.serviceName, input.appName),
    ...input.hostnames,
    ...input.routes.map((route) => route.hostname),
    ...(input.defaultRouteHostname === undefined ? [] : [input.defaultRouteHostname]),
    "localhost",
    "127.0.0.1",
  ];
  return [...new Set(candidates)];
};

const resolveAuthoredPath = (
  input: ResolveCertsFeatureInput,
  authoredPath: string,
): Effect.Effect<string, LandofileValidationError> =>
  Effect.tryPromise({
    try: () => assertUnderRoot(input.appRoot, resolve(input.appRoot, authoredPath), authoredPath),
    catch: () =>
      validationError(
        input,
        `path ${authoredPath} must stay inside the app root. Move the certificate material into the app or issue a certificate with certs: true.`,
      ),
  }).pipe(
    Effect.flatMap((containedPath) => {
      const fileSystem = input.fileSystem;
      if (fileSystem === undefined) {
        return Effect.fail(
          validationError(
            input,
            "requires FileSystem to validate custom certificate material. Restore the standard app runtime services and retry.",
          ),
        );
      }
      const unreadable = validationError(
        input,
        `path ${authoredPath} could not be read. Create the file or point certs at existing certificate material.`,
      );
      return fileSystem.stat(containedPath).pipe(
        Effect.mapError(() => unreadable),
        Effect.flatMap((stat) =>
          stat.isFile
            ? fileSystem.readFile(containedPath).pipe(
                Effect.as(containedPath),
                Effect.mapError(() => unreadable),
              )
            : Effect.fail(validationError(input, `path ${authoredPath} must be a regular file.`)),
        ),
      );
    }),
  );

const issueCertificate = (
  input: ResolveCertsFeatureInput,
): Effect.Effect<CertsFeatureConfig, LandofileValidationError> =>
  Effect.gen(function* () {
    const resolveAuthority = input.resolveCertificateAuthority;
    if (resolveAuthority === undefined) {
      return yield* Effect.fail(
        validationError(input, `requires an active certificate authority. ${CA_REMEDIATION}`),
      );
    }
    const ca = yield* resolveAuthority.pipe(
      Effect.mapError((cause) =>
        validationError(
          input,
          `${cause.message} ${"remediation" in cause ? cause.remediation : CA_REMEDIATION}`,
        ),
      ),
    );
    const cn = internalAlias(input.serviceName, input.appName);
    const sans = certificateSans(input);
    const issued = yield* ca
      .issueCert({ cn, sans })
      .pipe(
        Effect.mapError((cause) =>
          validationError(input, `could not be issued: ${cause.message}. ${CA_REMEDIATION}`),
        ),
      );
    return { certPath: issued.certPath, keyPath: issued.keyPath, cn, sans, caId: ca.id };
  });

export const resolveCertsFeature = (
  input: ResolveCertsFeatureInput,
): Effect.Effect<
  { readonly id: typeof CERTS_FEATURE_ID; readonly config: CertsFeatureConfig },
  LandofileValidationError
> =>
  Effect.gen(function* () {
    const { certs } = input;
    if (certs === undefined || certs === false) return { id: CERTS_FEATURE_ID, config: {} };
    if (certs === true) return { id: CERTS_FEATURE_ID, config: yield* issueCertificate(input) };

    const authoredCert = typeof certs === "string" ? certs : certs.cert;
    const authoredKey = typeof certs === "string" ? undefined : certs.key;
    const certPath = yield* resolveAuthoredPath(input, authoredCert);
    const keyPath = authoredKey === undefined ? undefined : yield* resolveAuthoredPath(input, authoredKey);
    return { id: CERTS_FEATURE_ID, config: { certPath, ...(keyPath === undefined ? {} : { keyPath }) } };
  });
