import { sha256Hex } from "@lando/sdk/digest";
import { LandofileLoadFailure } from "@lando/sdk/errors";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { captureCompilationContext } from "./compilation.ts";
import { createIncludeResolutionSession, publishIncludeProposals } from "./include-session.ts";
import { LANDOFILE_LAYER_POSITIONS, type PresentLandofileLayer } from "./layers.ts";
import { ensureConsistentRoot } from "./load-context.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { createLoadFailureRecorder } from "./load-failures.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { prepareLandofileValue } from "./source.ts";

export const loadAuthoredDocuments = Effect.fn("Landofile.loadDocuments")(function* (
  sources: readonly { readonly file: string; readonly value: unknown; readonly content?: string }[],
  context: { readonly appRoot: string; readonly file: string },
  inputs?: LandofileRuntimeInputs,
) {
  yield* ensureConsistentRoot(context.appRoot, inputs);
  const session = yield* createIncludeResolutionSession({ appRoot: context.appRoot, ...inputs });
  const pendingSites: ParsedPendingSite[] = [];
  const recorder = createLoadFailureRecorder();
  const compilationContext = captureCompilationContext(context.appRoot, inputs?.templates.context?.env);
  const rootDocuments: SourceDocument[] = [];
  const prepared = yield* Effect.forEach(sources, (source) => {
    const position =
      LANDOFILE_LAYER_POSITIONS.find(
        ({ basename }) => source.file.endsWith(`${basename}.yml`) || source.file.endsWith(`${basename}.ts`),
      ) ?? LANDOFILE_LAYER_POSITIONS[3];
    const layer: PresentLandofileLayer = {
      filePath: source.file,
      layer: position?.layer ?? "canonical",
      order: position?.order ?? 3,
      basename: position?.basename ?? ".lando",
    };
    if (source.content !== undefined)
      rootDocuments.push({
        file: source.file,
        form: source.file.endsWith(".ts") ? "typescript" : "yaml",
        layer: layer.layer,
        content: source.content,
        digest: sha256Hex(source.content),
        document: source.value,
      });
    return prepareLandofileValue({
      ...source,
      context: {
        appRoot: context.appRoot,
        compilationContext,
        pendingSites,
        recorder,
        layer: layer.layer,
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
      },
    }).pipe(
      Effect.map(({ value }) => [{ layer, landofile: value }]),
      Effect.catch((error) => {
        if (!Schema.is(LandofileLoadFailure)(error)) return Effect.fail(error);
        recorder.record(error);
        return Effect.succeed([]);
      }),
    );
  });
  const { document, scope } = yield* composePreparedLayers(
    prepared.flat(),
    {
      appRoot: context.appRoot,
      pendingSites,
      recorder,
      compilationContext,
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
    },
    { session, ...(inputs === undefined ? {} : { inputs }) },
  );
  const compiled = yield* finalizeLandofile(context.file, document, {
    ...context,
    rootDocuments,
    env: compilationContext.env,
    pendingSites,
    recorder,
    scope,
  });
  yield* publishIncludeProposals(session, inputs?.stateStore);
  return compiled;
});
