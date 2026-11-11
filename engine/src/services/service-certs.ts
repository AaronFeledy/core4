/**
 * Service leaf-certificate planning.
 *
 * Planning is pure: it derives the SAN coverage for a service, selects the
 * certificate authority that apply will use, and seeds the `lando.certs`
 * feature with the Lando-owned leaf paths. Apply issues and copies the
 * material into those paths. Custom certificate material authored on the
 * Landofile is contained to the app root and checked for readability here so
 * the feature stays a pure mount/env application.
 */
import { resolve } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";

import { type Context, Effect, Result, Schema } from "effect";

import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import {
  type AmbiguousCertificateAuthoritiesError,
  LandofileValidationError,
  type NoCertificateAuthorityError,
} from "@lando/sdk/errors";
import {
  type AppId,
  type AppIdentity,
  type AppRef,
  CertificateName,
  type ServiceConfig,
  appIdentityKey,
  certificateNameForHostname,
  validationIssue,
} from "@lando/sdk/schema";
import type { FileSystem } from "@lando/sdk/services";

import { assertUnderRoot } from "@lando/landofile/include-guard";
import { routeOwnerFromScratch } from "../lifecycle/route-owner.ts";
import { serviceCertificatePaths } from "../lifecycle/service-certificate-paths.ts";

export const CERTS_FEATURE_ID = "lando.certs" as const;

const CUSTOM_MATERIAL_REMEDIATION =
  "Use valid certificate material under the app root, or set certs to false.";

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
  /** The authority apply will issue from, selected without contacting it. */
  readonly certificateAuthority: Result.Result<
    { readonly id: string },
    NoCertificateAuthorityError | AmbiguousCertificateAuthoritiesError
  >;
  readonly leafLocation: { readonly certsDir: string; readonly ownerKey: string };
  readonly fileSystem?: Pick<Context.Service.Shape<typeof FileSystem>, "stat" | "readFile"> | undefined;
}

/**
 * Where an app's generated leaves live. The owner is the one the route and teardown paths derive
 * from the finished plan; scratch is keyed by id because the scratch marker is attached after
 * planning and cwd forks share the user app's root.
 */
export const certificateLeafLocation = (app: {
  readonly certsDir: string;
  readonly kind: AppRef["kind"] | undefined;
  readonly id: AppId;
  readonly root: string;
  readonly identity: AppIdentity | undefined;
}): ResolveCertsFeatureInput["leafLocation"] => ({
  certsDir: app.certsDir,
  ownerKey:
    app.kind === "scratch"
      ? routeOwnerFromScratch(app.id).ownerKey
      : (app.identity?.ownerKey ?? appIdentityKey("owner", app.root)),
});

const validationError = (
  input: ResolveCertsFeatureInput,
  failure: { readonly message: string; readonly remediation: string; readonly cause?: unknown },
): LandofileValidationError =>
  new LandofileValidationError({
    message: `services.${input.serviceName}.certs ${failure.message}`,
    remediation: failure.remediation,
    file: `${input.appRoot}/.lando.yml`,
    issues: [validationIssue(["services", input.serviceName, "certs"], failure.message, failure.remediation)],
    cause: failure.cause,
  });

const customMaterialError = (input: ResolveCertsFeatureInput, message: string, cause?: unknown) =>
  validationError(input, { message, remediation: CUSTOM_MATERIAL_REMEDIATION, cause });

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

/** Mandatory identities must be certificate names before a certificate is planned. */
const requireMandatoryCertificateIdentities = (
  input: ResolveCertsFeatureInput,
): Effect.Effect<void, LandofileValidationError> => {
  const identity = [input.serviceName, internalAlias(input.serviceName, input.appName)].find(
    (name) => !Schema.is(CertificateName)(name),
  );
  return identity === undefined
    ? Effect.void
    : Effect.fail(
        validationError(input, {
          message: `identity ${identity} is not a valid certificate name.`,
          remediation:
            "Use a DNS-shaped service and app name (letters, digits, hyphens, underscores), or set certs to false.",
        }),
      );
};

const resolveAuthoredPath = (
  input: ResolveCertsFeatureInput,
  authoredPath: string,
): Effect.Effect<string, LandofileValidationError> =>
  Effect.tryPromise({
    try: () => assertUnderRoot(input.appRoot, resolve(input.appRoot, authoredPath), authoredPath),
    catch: () =>
      validationError(input, {
        message: `path ${authoredPath} must stay inside the app root.`,
        remediation:
          "Move the certificate material into the app, or set certs to true to use a generated certificate.",
      }),
  }).pipe(
    Effect.flatMap((containedPath) => {
      const fileSystem = input.fileSystem;
      if (fileSystem === undefined) {
        return Effect.fail(
          validationError(input, {
            message: "requires FileSystem to validate custom certificate material.",
            remediation: "Restore the standard app runtime services and retry.",
          }),
        );
      }
      const unreadable = (cause: unknown) =>
        customMaterialError(input, `path ${authoredPath} could not be read.`, cause);
      return fileSystem.stat(containedPath).pipe(
        mapFailures(unreadable),
        Effect.flatMap((stat) =>
          stat.isFile
            ? fileSystem.readFile(containedPath).pipe(Effect.as(containedPath), mapFailures(unreadable))
            : Effect.fail(customMaterialError(input, `path ${authoredPath} must be a regular file.`)),
        ),
      );
    }),
  );

const planGeneratedCertificate = (
  input: ResolveCertsFeatureInput,
): Effect.Effect<CertsFeatureConfig, LandofileValidationError> =>
  requireMandatoryCertificateIdentities(input).pipe(
    Effect.flatMap(() =>
      Result.match(input.certificateAuthority, {
        onFailure: (failure) =>
          Effect.fail(validationError(input, { message: failure.message, remediation: failure.remediation })),
        onSuccess: (authority) =>
          Effect.succeed({
            ...serviceCertificatePaths(
              input.leafLocation.certsDir,
              input.leafLocation.ownerKey,
              input.serviceName,
            ),
            cn: internalAlias(input.serviceName, input.appName),
            sans: certificateSans(input),
            caId: authority.id,
          }),
      }),
    ),
  );

export const resolveCertsFeature = Effect.fnUntraced(function* (
  input: ResolveCertsFeatureInput,
): Effect.fn.Return<
  { readonly id: typeof CERTS_FEATURE_ID; readonly config: CertsFeatureConfig },
  LandofileValidationError
> {
  const { certs } = input;
  if (certs === undefined || certs === false) return { id: CERTS_FEATURE_ID, config: {} };
  if (certs === true) return { id: CERTS_FEATURE_ID, config: yield* planGeneratedCertificate(input) };

  const authoredCert = typeof certs === "string" ? certs : certs.cert;
  const authoredKey = typeof certs === "string" ? undefined : certs.key;
  const certPath = yield* resolveAuthoredPath(input, authoredCert);
  const keyPath = authoredKey === undefined ? undefined : yield* resolveAuthoredPath(input, authoredKey);
  return { id: CERTS_FEATURE_ID, config: { certPath, ...(keyPath === undefined ? {} : { keyPath }) } };
});
