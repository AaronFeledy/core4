import { createHash as createNodeHash } from "node:crypto";
import { join, resolve } from "node:path";

import { type Context, Effect } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import type { NetworkTrustPlan } from "@lando/sdk/network-trust";
import type { NetworkConfig, ServiceConfig } from "@lando/sdk/schema";
import type { StringImportRef } from "@lando/sdk/schema";
import type { FileSystem, LandoPaths } from "@lando/sdk/services";

import { assertUnderRoot } from "@lando/landofile/include-guard";
import { type LoadedCaPem, loadCaPems, resolveServiceNetworkInject } from "../http-client/network-trust.ts";

const CERTIFICATE_PEM_PATTERN = /^(?:\s*-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\s*)+$/u;
const SECURITY_FEATURE_ID = "lando.security" as const;

interface SecurityFeatureConfig extends Readonly<Record<string, unknown>> {
  readonly injectCa: boolean;
  readonly injectProxy: boolean;
  readonly cas: ReadonlyArray<{ readonly path: string; readonly digest: string }>;
  readonly bundlePath?: string;
  readonly proxy?: NetworkTrustPlan["proxy"];
}

interface ResolveSecurityFeatureInput {
  readonly appName: string;
  readonly appRoot: string;
  readonly serviceName: string;
  readonly security?: ServiceConfig["security"] | undefined;
  readonly network?: NetworkConfig | undefined;
  readonly networkPlan: NetworkTrustPlan;
  readonly globalCas: ReadonlyArray<LoadedCaPem>;
  readonly fileSystem?: Context.Tag.Service<typeof FileSystem> | undefined;
  readonly paths?: LandoPaths | undefined;
}

const validationError = (input: ResolveSecurityFeatureInput, message: string): LandofileValidationError =>
  new LandofileValidationError({
    message: `Service ${input.serviceName} security.ca ${message}`,
    file: `${input.appRoot}/.lando.yml`,
    issues: [`services.${input.serviceName}.security.ca`],
  });

const validatePem = (
  input: ResolveSecurityFeatureInput,
  ca: LoadedCaPem,
): Effect.Effect<LoadedCaPem, LandofileValidationError> =>
  CERTIFICATE_PEM_PATTERN.test(ca.pem)
    ? Effect.succeed(ca)
    : Effect.fail(
        validationError(
          input,
          `must resolve to a valid PEM certificate; ${ca.path} did not contain a complete CERTIFICATE block.`,
        ),
      );

const loadPaths = (
  input: ResolveSecurityFeatureInput,
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<LoadedCaPem>, LandofileValidationError> =>
  loadCaPems(paths).pipe(
    Effect.mapError((cause) => validationError(input, `${cause.message}. ${cause.remediation}`)),
    Effect.flatMap((loaded) => Effect.forEach(loaded, (ca) => validatePem(input, ca))),
  );

export const loadGlobalSecurityCas = (
  appRoot: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<LoadedCaPem>, LandofileValidationError> =>
  loadCaPems(paths).pipe(
    Effect.mapError(
      (cause) =>
        new LandofileValidationError({
          message: `Global network CA could not be loaded: ${cause.message}. ${cause.remediation}`,
          file: `${appRoot}/.lando.yml`,
          issues: ["network.ca.certs"],
        }),
    ),
    Effect.flatMap((cas) =>
      Effect.forEach(cas, (ca) =>
        CERTIFICATE_PEM_PATTERN.test(ca.pem)
          ? Effect.succeed(ca)
          : Effect.fail(
              new LandofileValidationError({
                message: `Global network CA ${ca.path} must contain a valid PEM certificate. Point network.ca.certs or LANDO_NETWORK_CA_CERTS at a complete CERTIFICATE block.`,
                file: `${appRoot}/.lando.yml`,
                issues: ["network.ca.certs"],
              }),
            ),
      ),
    ),
  );

const isInlinePemInput = (value: string): boolean =>
  value.includes("-----BEGIN CERTIFICATE-----") || value.includes("\n") || value.includes("\r");

const loadProjectCas = (
  input: ResolveSecurityFeatureInput,
  cacheDirectory: string,
  paths: ReadonlyArray<string | StringImportRef>,
): Effect.Effect<ReadonlyArray<LoadedCaPem>, LandofileValidationError> =>
  Effect.forEach(paths, (entry) => {
    if (typeof entry !== "string") {
      const digest = createNodeHash("sha256").update(entry.value, "utf-8").digest("hex");
      if (digest !== entry.checksum) {
        return Effect.fail(
          validationError(input, `import checksum for ${entry.path} did not match its PEM content.`),
        );
      }
      return validatePem(input, {
        path: join(cacheDirectory, `import-${digest}-${entry.basename.replace(/[^A-Za-z0-9._-]/gu, "-")}`),
        pem: entry.value,
        digest,
      });
    }
    const authoredPath = entry;
    if (isInlinePemInput(authoredPath)) {
      const digest = createNodeHash("sha256").update(authoredPath, "utf-8").digest("hex");
      return validatePem(input, {
        path: join(cacheDirectory, `inline-${digest}.pem`),
        pem: authoredPath,
        digest,
      });
    }

    const candidate = resolve(input.appRoot, authoredPath);
    return Effect.tryPromise({
      try: () => assertUnderRoot(input.appRoot, candidate, authoredPath),
      catch: () =>
        validationError(
          input,
          `path ${authoredPath} must stay inside the app root. Move the certificate into the app or remove the entry.`,
        ),
    }).pipe(
      Effect.flatMap((containedPath) => loadPaths(input, [containedPath])),
      Effect.flatMap(([ca]) =>
        ca === undefined
          ? Effect.fail(validationError(input, `path ${authoredPath} did not produce a CA certificate.`))
          : Effect.succeed(ca),
      ),
    );
  });

const dedupeCas = (cas: ReadonlyArray<LoadedCaPem>): ReadonlyArray<LoadedCaPem> => {
  const seen = new Set<string>();
  return cas.filter((ca) => {
    if (seen.has(ca.digest)) return false;
    seen.add(ca.digest);
    return true;
  });
};

export const resolveSecurityFeature = (
  input: ResolveSecurityFeatureInput,
): Effect.Effect<
  { readonly id: typeof SECURITY_FEATURE_ID; readonly config: SecurityFeatureConfig },
  LandofileValidationError
> =>
  Effect.gen(function* () {
    const resolved = resolveServiceNetworkInject({
      network: input.network,
      env: process.env,
      security: input.security,
      plan: input.networkPlan,
    });
    const landofileCaPaths = resolved.landofileCaPaths ?? [];
    const hasCaInputs = resolved.caPaths.length > 0 || landofileCaPaths.length > 0;
    if (!hasCaInputs) {
      return {
        id: SECURITY_FEATURE_ID,
        config: {
          injectCa: false,
          injectProxy: resolved.injectProxy,
          cas: [],
          ...(resolved.injectProxy ? { proxy: resolved.proxy } : {}),
        },
      };
    }
    if (input.fileSystem === undefined || input.paths === undefined) {
      return yield* Effect.fail(
        validationError(
          input,
          "requires FileSystem and PathsService to materialize CA inputs. Restore the standard app runtime services and retry.",
        ),
      );
    }

    const cacheDirectory = join(input.paths.appCacheDir(input.appName, input.appRoot), "security");
    const globalCas = resolved.injectCa ? input.globalCas : [];
    const projectCas = yield* loadProjectCas(input, cacheDirectory, landofileCaPaths);
    const cas = dedupeCas([...globalCas, ...projectCas]);
    yield* input.fileSystem
      .mkdir(cacheDirectory)
      .pipe(
        Effect.mapError((cause) =>
          validationError(input, `could not create its app cache: ${cause.message}`),
        ),
      );
    for (const ca of projectCas.filter((candidate) => candidate.path.startsWith(cacheDirectory))) {
      yield* input.fileSystem
        .writeAtomic(ca.path, ca.pem)
        .pipe(
          Effect.mapError((cause) =>
            validationError(input, `could not materialize inline PEM input: ${cause.message}`),
          ),
        );
    }
    const bundleDigest = createNodeHash("sha256")
      .update(cas.map((ca) => ca.digest).join(""), "utf-8")
      .digest("hex");
    const bundlePath = join(cacheDirectory, `ca-bundle-${bundleDigest}.pem`);
    const bundle = cas.map((ca) => (ca.pem.endsWith("\n") ? ca.pem : `${ca.pem}\n`)).join("");
    yield* input.fileSystem
      .writeAtomic(bundlePath, bundle)
      .pipe(
        Effect.mapError((cause) =>
          validationError(input, `could not write its app-cache CA bundle: ${cause.message}`),
        ),
      );

    return {
      id: SECURITY_FEATURE_ID,
      config: {
        injectCa: cas.length > 0,
        injectProxy: resolved.injectProxy,
        cas: cas.map(({ path, digest }) => ({ path, digest })),
        bundlePath,
        ...(resolved.injectProxy ? { proxy: resolved.proxy } : {}),
      },
    };
  });
