import { basename } from "node:path";
import { parseLandofile } from "@lando/landofile/parser";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { provenanceOf } from "@lando/landofile/provenance";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import {
  assertReadableRoot,
  compileSelectedLandofileRoot,
  findDiscoveredLandofilePath,
  selectLandofileRoot,
} from "@lando/landofile/service";
import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import {
  LandofileNotFoundError,
  LandofileVersionConstraintError,
  ScratchAppError,
  ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import type { LoadScopedLandofile } from "@lando/sdk/schema";
import type { ScratchAcquireInput } from "@lando/sdk/services";
import { Context, Effect, Option, Result } from "effect";
import { assertLandoVersionConstraint, assertUserAppIdNotReserved } from "../landofile/app-resolution.ts";
import type { PluginContributionGraphShape } from "../plugins/contribution-graph.ts";
import {
  ScratchForkSource,
  admitScratchFork,
  checkAdmittedForkRoot,
  scratchForkLoadFailure,
} from "./fork-source.ts";

export const selectScratchForkSource = Effect.fnUntraced(function* (
  request: {
    readonly source: Extract<ScratchAcquireInput["source"], { readonly kind: "fork" }>;
    readonly cwd: string;
    readonly graph?: PluginContributionGraphShape | undefined;
  },
  options: {
    readonly inputs: LandofileRuntimeInputs;
    readonly noLocalOverrides: ScratchAcquireInput["noLocalOverrides"];
    readonly full: boolean;
  },
) {
  const { cwd, source, graph } = request;
  const { inputs } = options;
  const omitLocalOverrides = options.noLocalOverrides === true;
  const selectRoot = (appRoot: string) =>
    selectLandofileRoot({ appRoot, inputs, omitLocalOverrides, contained: options.full });
  if (source.path === undefined) {
    const selection = yield* assertReadableRoot(cwd, inputs).pipe(
      Effect.andThen(findDiscoveredLandofilePath(cwd, { omitLocalOverrides })),
      Effect.flatMap(({ appRoot }) => selectRoot(appRoot)),
      mapFailures((cause) =>
        cause instanceof LandofileNotFoundError
          ? new ScratchSourceUnresolvedError({
              message: "Unable to resolve scratch source fork.",
              source: "fork",
              attempts: [],
              remediation: cause.remediation,
            })
          : scratchForkLoadFailure(cwd, cause),
      ),
    );
    return { selection, admitted: undefined };
  }

  const proof =
    graph === undefined
      ? undefined
      : Option.getOrUndefined(Context.getOption(graph.hostContext, ScratchForkSource));
  // Native admission is private to this exact source object; retained calls compare manifests.
  const native = proof?.source === source && proof.cwd === cwd;
  const admitted = native
    ? yield* Effect.flatMap(proof.admission, (admission) =>
        Result.isSuccess(admission) ? Effect.succeed(admission.success) : Effect.fail(admission.failure),
      )
    : yield* admitScratchFork(cwd, source.path, omitLocalOverrides);
  yield* admitted.verify;
  yield* assertReadableRoot(admitted.discovery.cwd, inputs).pipe(
    mapFailures((cause) => scratchForkLoadFailure(admitted.root, cause)),
  );
  const selection = yield* selectRoot(admitted.root).pipe(
    mapFailures((cause) => scratchForkLoadFailure(admitted.root, cause)),
  );
  yield* checkAdmittedForkRoot(admitted, selection.appRoot);
  if (
    !native &&
    graph?.matchesAppPluginSelection !== undefined &&
    !(yield* graph.matchesAppPluginSelection(admitted.root))
  ) {
    return yield* new ScratchAppError({
      operation: "acquire",
      message: `Cannot fork the app at ${admitted.root} from ${cwd}: its plugin selection differs from this runtime's.`,
      remediation:
        "Run the fork from the source app, or acquire a runtime with a plugin selection that matches the source app.",
    });
  }
  yield* admitted.verify;
  return { selection, admitted };
});

type SelectedRoot = Effect.Success<ReturnType<typeof selectLandofileRoot>>;

export const compileScratchForkRoot = (
  selection: SelectedRoot,
  inputs: LandofileRuntimeInputs,
  pins: Parameters<typeof compileSelectedLandofileRoot>[2],
): Effect.Effect<Effect.Success<ReturnType<typeof compileSelectedLandofileRoot>>, ScratchAppError> =>
  compileSelectedLandofileRoot(selection, inputs, pins).pipe(
    mapFailures(
      (cause) =>
        new ScratchAppError({
          operation: "materialize",
          message: `Unable to compile the scratch fork Landofile at ${selection.appRoot}: ${cause.message}`,
          cause,
          remediation: causeRemediation(cause) ?? "Correct the fork's Landofile inputs and retry.",
        }),
    ),
  );

export const selectCopiedScratchRoot = Effect.fnUntraced(function* (input: {
  readonly source: SelectedRoot;
  readonly appRoot: string;
  readonly inputs: LandofileRuntimeInputs;
  readonly omitLocalOverrides: boolean;
}) {
  return yield* selectLandofileRoot({ ...input, contained: true }).pipe(
    Effect.tap((copied) =>
      Effect.gen(function* () {
        const names = new Set(copied.layers.map(({ filePath }) => basename(filePath)));
        const missing = input.source.layers.find(({ filePath }) => !names.has(basename(filePath)));
        const file =
          missing?.filePath ??
          (input.source.lockfilePresent && !copied.lockfilePresent ? input.source.lockfile : undefined);
        if (file !== undefined)
          return yield* new ScratchAppError({
            operation: "materialize",
            message: `Landofile input ${basename(file)} is missing from the scratch copy.`,
            remediation: "Keep Landofile layers and their file targets inside the copied app.",
          });
      }),
    ),
    mapFailures((cause) =>
      cause instanceof ScratchAppError
        ? cause
        : new ScratchAppError({
            operation: "materialize",
            message: `Unable to load the Landofile from the scratch copy at ${input.appRoot}: ${cause.message}`,
            cause,
            remediation: causeRemediation(cause) ?? "Correct the fork's Landofile inputs and retry.",
          }),
    ),
  );
});

export const assertScratchForkLandofile = (landofile: LoadScopedLandofile) =>
  assertUserAppIdNotReserved(landofile.document).pipe(
    mapFailures(
      (cause) =>
        new ScratchAppError({
          operation: "materialize",
          message: cause.message,
          cause,
          remediation: cause.remediation,
        }),
    ),
    Effect.andThen(
      assertLandoVersionConstraint(landofile.document, provenanceOf(landofile), {
        env: landofile.context.env,
      }).pipe(
        mapFailures((cause) =>
          cause instanceof LandofileVersionConstraintError
            ? cause
            : new ScratchAppError({
                operation: "materialize",
                message: cause.message,
                cause,
                remediation: cause.remediation,
              }),
        ),
      ),
    ),
  );

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
