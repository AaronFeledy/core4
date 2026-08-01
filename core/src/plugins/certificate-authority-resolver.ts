import { Context, Effect, Either, Layer, Scope } from "effect";

import {
  AmbiguousCertificateAuthoritiesError,
  NoCertificateAuthorityError,
  PluginLoadError,
} from "@lando/sdk/errors";
import type { CertificateAuthorityContributionLayer } from "@lando/sdk/plugins";
import { CertificateAuthority, Downloader, PathsService, ProcessRunner } from "@lando/sdk/services";

import { type GraphCertificateAuthorityCandidate, PluginContributionGraph } from "./contribution-graph.ts";

export interface CertificateAuthorityCandidateDefinition {
  readonly id: string;
  readonly pluginName: string;
  readonly source: string;
  readonly defaultFor?: { readonly platform?: ReadonlyArray<string> | undefined } | undefined;
  readonly acquire: undefined;
}

type SelectionError = NoCertificateAuthorityError | AmbiguousCertificateAuthoritiesError;

const candidateContext = (candidate: CertificateAuthorityCandidateDefinition) => ({
  id: candidate.id,
  pluginName: candidate.pluginName,
  source: candidate.source,
});

export const selectCertificateAuthorityCandidate = <
  Candidate extends CertificateAuthorityCandidateDefinition,
>(
  candidates: ReadonlyArray<Candidate>,
  platform: string,
): Either.Either<Candidate, SelectionError> => {
  const defaults = candidates.filter(
    (candidate) => candidate.defaultFor?.platform?.includes(platform) === true,
  );
  const soleDefault = defaults[0];
  if (defaults.length === 1 && soleDefault !== undefined) return Either.right(soleDefault);
  if (defaults.length > 1) {
    return Either.left(
      new AmbiguousCertificateAuthoritiesError({
        message: `Multiple certificate authorities declare defaultFor platform ${platform}.`,
        candidates: defaults.map(candidateContext),
        remediation: "Disable all but one matching certificate authority plugin.",
      }),
    );
  }
  const soleCandidate = candidates[0];
  if (candidates.length === 1 && soleCandidate !== undefined) return Either.right(soleCandidate);
  if (candidates.length === 0) {
    return Either.left(
      new NoCertificateAuthorityError({
        message: "No certificate authority is available.",
        candidates: [],
        remediation: "Enable or install a certificate authority plugin, or provide custom certificate paths.",
      }),
    );
  }
  return Either.left(
    new AmbiguousCertificateAuthoritiesError({
      message: "Multiple certificate authorities are available and none is the platform default.",
      candidates: candidates.map(candidateContext),
      remediation:
        "Disable all but one certificate authority plugin or add one matching defaultFor declaration.",
    }),
  );
};

export interface CertificateAuthorityResolverShape {
  readonly resolve: Effect.Effect<
    Context.Tag.Service<typeof CertificateAuthority>,
    SelectionError | PluginLoadError
  >;
}

export class CertificateAuthorityResolver extends Context.Tag(
  "@lando/core/private/CertificateAuthorityResolver",
)<CertificateAuthorityResolver, CertificateAuthorityResolverShape>() {}

const isModuleRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isCertificateAuthorityLayer = (value: unknown): value is CertificateAuthorityContributionLayer =>
  Layer.isLayer(value);

const loadContributionLayer = (
  candidate: GraphCertificateAuthorityCandidate,
): Effect.Effect<CertificateAuthorityContributionLayer, PluginLoadError> => {
  const acquisition = candidate.acquisition;
  if (acquisition.kind === "layer") return Effect.succeed(acquisition.layer);
  if (acquisition.kind === "service") {
    return Effect.succeed(Layer.succeed(CertificateAuthority, acquisition.service));
  }
  return Effect.tryPromise({
    try: () => import(acquisition.module),
    catch: (cause) =>
      new PluginLoadError({
        message: `Failed to import certificate authority ${candidate.id} from ${acquisition.module}.`,
        pluginName: candidate.pluginName,
        cause,
      }),
  }).pipe(
    Effect.flatMap((loaded) => {
      const candidateLayer = isModuleRecord(loaded)
        ? (loaded.ca ?? loaded.default ?? loaded.layer)
        : undefined;
      return isCertificateAuthorityLayer(candidateLayer)
        ? Effect.succeed(candidateLayer)
        : Effect.fail(
            new PluginLoadError({
              message: `Certificate authority module ${acquisition.module} does not export a ca Layer.`,
              pluginName: candidate.pluginName,
            }),
          );
    }),
  );
};

export const CertificateAuthorityResolverLive = Layer.scoped(
  CertificateAuthorityResolver,
  Effect.gen(function* () {
    const graph = yield* PluginContributionGraph;
    const paths = yield* PathsService;
    const downloader = yield* Downloader;
    const processRunner = yield* ProcessRunner;
    const scope = yield* Scope.Scope;
    const selected = selectCertificateAuthorityCandidate(
      graph.certificateAuthorities.map((candidate) => ({ ...candidate, acquire: undefined })),
      process.platform,
    );
    const acquire: Effect.Effect<
      Context.Tag.Service<typeof CertificateAuthority>,
      SelectionError | PluginLoadError
    > = Either.match(selected, {
      onLeft: Effect.fail,
      onRight: (selection) => {
        const original = graph.certificateAuthorities.find(
          (candidate) =>
            candidate.id === selection.id &&
            candidate.pluginName === selection.pluginName &&
            candidate.source === selection.source,
        );
        if (original === undefined) {
          return Effect.fail(
            new PluginLoadError({
              message: `Selected certificate authority ${selection.id} disappeared from the contribution graph.`,
              pluginName: selection.pluginName,
            }),
          );
        }
        return loadContributionLayer(original).pipe(
          Effect.flatMap((layer) =>
            Layer.buildWithScope(
              layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(PathsService, paths),
                    Layer.succeed(Downloader, downloader),
                    Layer.succeed(ProcessRunner, processRunner),
                  ),
                ),
              ),
              scope,
            ),
          ),
          Effect.map((context) => Context.get(context, CertificateAuthority)),
        );
      },
    });
    const cached = yield* Effect.cached(acquire);
    return { resolve: cached };
  }),
);
