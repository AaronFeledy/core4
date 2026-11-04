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

import { type Context, Effect, Result, Schema } from "effect";

import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import {
  type AmbiguousCertificateAuthoritiesError,
  LandofileValidationError,
  type NoCertificateAuthorityError,
  type PluginLoadError,
} from "@lando/sdk/errors";
import {
  CertificateName,
  type HostPlatform,
  type ServiceConfig,
  certificateNameForHostname,
  validationIssue,
} from "@lando/sdk/schema";
import type { CertificateAuthorityShape, FileSystem } from "@lando/sdk/services";

import { assertUnderRoot } from "@lando/landofile/include-guard";
import {
  type CertificateAuthorityCandidateDefinition,
  selectCertificateAuthorityCandidate,
} from "../plugins/certificate-authority-resolver.ts";

export const CERTS_FEATURE_ID = "lando.certs" as const;

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
  readonly routes: ReadonlyArray<NormalizedRoute>;
  readonly defaultRouteHostname?: string | undefined;
  readonly resolveCertificateAuthority?:
    | Effect.Effect<
        CertificateAuthorityShape,
        NoCertificateAuthorityError | AmbiguousCertificateAuthoritiesError | PluginLoadError
      >
    | undefined;
  readonly fileSystem?: Pick<Context.Service.Shape<typeof FileSystem>, "stat" | "readFile"> | undefined;
  readonly validation?: {
    readonly authorities: readonly CertificateAuthorityCandidateDefinition[];
    readonly platform: HostPlatform;
  };
}

const validationError = (
  input: ResolveCertsFeatureInput,
  message: string,
  cause?: unknown,
): LandofileValidationError =>
  new LandofileValidationError({
    message: `services.${input.serviceName}.certs ${message}`,
    remediation: "Use valid certificate material under the app root, or set certs to false.",
    file: `${input.appRoot}/.lando.yml`,
    issues: [validationIssue(["services", input.serviceName, "certs"], message)],
    cause,
  });

const internalAlias = (serviceName: string, appName: string): string => `${serviceName}.${appName}.internal`;

/** Keep first occurrence; compare case-insensitively. */
const dedupeCertificateNames = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
};

const certificateSans = (input: ResolveCertsFeatureInput): ReadonlyArray<string> => {
  const routeHostnames = [
    ...input.routes.map((route) => route.hostname),
    ...(input.defaultRouteHostname === undefined ? [] : [input.defaultRouteHostname]),
  ];
  return dedupeCertificateNames([
    input.serviceName,
    internalAlias(input.serviceName, input.appName),
    ...input.hostnames,
    ...routeHostnames.flatMap((hostname) => certificateNameForHostname(hostname) ?? []),
    "localhost",
    "127.0.0.1",
  ]);
};

/** Mandatory identities must be certificate names before the CA is contacted. */
const requireMandatoryCertificateIdentities = (
  input: ResolveCertsFeatureInput,
): Effect.Effect<void, LandofileValidationError> => {
  const identity = [input.serviceName, internalAlias(input.serviceName, input.appName)].find(
    (name) => !Schema.is(CertificateName)(name),
  );
  return identity === undefined
    ? Effect.void
    : Effect.fail(
        validationError(
          input,
          `identity ${identity} is not a valid certificate name. Use a DNS-shaped service name (letters, digits, hyphens, underscores) or disable certs.`,
        ),
      );
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
      const unreadable = (cause: unknown) =>
        validationError(
          input,
          `path ${authoredPath} could not be read. Create the file or point certs at existing certificate material.`,
          cause,
        );
      return fileSystem.stat(containedPath).pipe(
        Effect.mapError(unreadable),
        Effect.flatMap((stat) =>
          stat.isFile
            ? fileSystem.readFile(containedPath).pipe(Effect.as(containedPath), Effect.mapError(unreadable))
            : Effect.fail(validationError(input, `path ${authoredPath} must be a regular file.`)),
        ),
      );
    }),
  );

const issueCertificate = Effect.fn("CertificateAuthority.issue")(function* (
  input: ResolveCertsFeatureInput,
): Effect.fn.Return<CertsFeatureConfig, LandofileValidationError> {
  yield* requireMandatoryCertificateIdentities(input);
  const cn = internalAlias(input.serviceName, input.appName);
  const sans = certificateSans(input);
  if (input.validation !== undefined) {
    const selected = selectCertificateAuthorityCandidate(
      input.validation.authorities,
      input.validation.platform,
    );
    if (Result.isFailure(selected))
      return yield* Effect.fail(
        validationError(input, `${selected.failure.message} ${selected.failure.remediation}`),
      );
    return { cn, sans, caId: selected.success.id };
  }
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
  const issued = yield* ca
    .issueCert({ cn, sans })
    .pipe(
      Effect.mapError((cause) =>
        validationError(input, `could not be issued: ${cause.message}. ${CA_REMEDIATION}`),
      ),
    );
  return { certPath: issued.certPath, keyPath: issued.keyPath, cn, sans, caId: ca.id };
});

export const resolveCertsFeature = Effect.fnUntraced(function* (
  input: ResolveCertsFeatureInput,
): Effect.fn.Return<
  { readonly id: typeof CERTS_FEATURE_ID; readonly config: CertsFeatureConfig },
  LandofileValidationError
> {
  const { certs } = input;
  if (certs === undefined || certs === false) return { id: CERTS_FEATURE_ID, config: {} };
  if (certs === true) return { id: CERTS_FEATURE_ID, config: yield* issueCertificate(input) };

  const authoredCert = typeof certs === "string" ? certs : certs.cert;
  const authoredKey = typeof certs === "string" ? undefined : certs.key;
  const certPath = yield* resolveAuthoredPath(input, authoredCert);
  const keyPath = authoredKey === undefined ? undefined : yield* resolveAuthoredPath(input, authoredKey);
  return { id: CERTS_FEATURE_ID, config: { certPath, ...(keyPath === undefined ? {} : { keyPath }) } };
});
