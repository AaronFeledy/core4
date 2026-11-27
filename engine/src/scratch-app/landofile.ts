import { OperationDiscovery, withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { mapFailures } from "@lando/sdk/command-result";
import {
  LandofileVersionConstraintError,
  ScratchAppError,
  ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import type { LoadScopedLandofile } from "@lando/sdk/schema";
import { Context, Effect, Option, Result } from "effect";
import type { UserLandofileError } from "../landofile/app-resolution.ts";
import type { PluginContributionGraphShape } from "../plugins/contribution-graph.ts";
import {
  ScratchForkSource,
  checkAdmittedForkRoot,
  scratchForkDirectory,
  scratchForkLoadFailure,
} from "./fork-source.ts";

export const loadScratchForkLandofile = Effect.fnUntraced(function* (
  request: {
    readonly cwd: string;
    readonly source: { readonly path?: string };
    readonly graph?: PluginContributionGraphShape | undefined;
  },
  load: Effect.Effect<LoadScopedLandofile, UserLandofileError>,
) {
  const { cwd, source, graph } = request;
  if (source.path === undefined) {
    const landofile = yield* load.pipe(
      mapFailures((cause) =>
        cause instanceof LandofileVersionConstraintError
          ? cause
          : new ScratchSourceUnresolvedError({
              message: "Unable to resolve scratch source fork.",
              source: "fork",
              attempts: [],
              remediation: "Run `lando apps:scratch:start --fork` from a directory containing a Landofile.",
            }),
      ),
    );
    return { landofile };
  }

  const proof =
    graph === undefined
      ? undefined
      : Option.getOrUndefined(Context.getOption(graph.hostContext, ScratchForkSource));
  const mapLoadFailure = (directory: string, cause: UserLandofileError) =>
    cause instanceof LandofileVersionConstraintError ? cause : scratchForkLoadFailure(directory, cause);
  // The source object is the native command's private token. Other calls on this graph still
  // take the retained-runtime comparison path, even if they pass the same path string.
  if (proof?.source === source && proof.cwd === cwd) {
    const admission = yield* proof.admission;
    if (Result.isFailure(admission)) return yield* admission.failure;
    const admitted = admission.success;
    yield* admitted.verify;
    const landofile = yield* load.pipe(
      Effect.provideService(OperationDiscovery, admitted.discovery),
      mapFailures((cause) => mapLoadFailure(admitted.root, cause)),
    );
    yield* checkAdmittedForkRoot(admitted, landofile.context.appRoot);
    yield* admitted.verify;
    return { landofile, admitted };
  }

  const directory = yield* scratchForkDirectory(cwd, source.path);
  const landofile = yield* withDiscoveryCwd(directory, load).pipe(
    mapFailures((cause) => mapLoadFailure(directory, cause)),
  );
  const root = landofile.context.appRoot;
  if (graph?.matchesAppPluginSelection !== undefined && !(yield* graph.matchesAppPluginSelection(root))) {
    return yield* new ScratchAppError({
      operation: "acquire",
      message: `Cannot fork the app at ${root} from ${cwd}: its plugin selection differs from this runtime's.`,
      remediation:
        "Run the fork from the source app, or acquire a runtime with a plugin selection that matches the source app.",
    });
  }
  return { landofile };
});

export const decodeScratchLandofile = (
  file: string,
  content: string,
  cwd: string,
): Effect.Effect<LoadScopedLandofile, ScratchAppError> =>
  parseLandofile({ file, content, cwd }).pipe(
    mapFailures(
      (cause) =>
        new ScratchAppError({
          operation: "materialize",
          message: `Unable to parse the rendered scratch Landofile at ${file}.`,
          cause,
          remediation: `Fix YAML syntax in ${file}, then retry scratch acquisition.`,
        }),
    ),
    Effect.flatMap((parsed) =>
      loadAuthoredDocuments([{ file, value: parsed, content }], { file, appRoot: cwd }).pipe(
        mapFailures(
          (cause) =>
            new ScratchAppError({
              operation: "materialize",
              message: `The rendered scratch Landofile at ${file} is invalid.`,
              cause,
              remediation: `Correct Landofile schema errors in ${file}, then retry scratch acquisition.`,
            }),
        ),
      ),
    ),
  );
