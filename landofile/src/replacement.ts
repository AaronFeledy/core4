import { join } from "node:path";
import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { LandofileAuthoringFragmentNative, validationIssue } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { type PresentLandofileLayer, presentLandofileLayers } from "./layers.ts";
import { ensureConsistentRoot, loadContext } from "./load-context.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import type { LandofileFinalizeOverrides } from "./pipeline/finalize-overrides.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { prepareLandofileSource, prepareLandofileValue } from "./source.ts";
import { landofileValidationError, validationErrorFromCause } from "./validation.ts";

export interface LandofileReplacement {
  readonly appRoot: string;
  readonly targetFile: string;
  readonly content: string;
}

export const validateLandofileReplacement = Effect.fn("Landofile.validateReplacement")(
  function* (
    replacement: LandofileReplacement,
    inputs: LandofileRuntimeInputs & { readonly overrides?: LandofileFinalizeOverrides | undefined },
  ) {
    yield* ensureConsistentRoot(replacement.appRoot, inputs);
    const runtime = yield* loadContext(replacement.appRoot, inputs.templates.context?.env);
    const layers = yield* presentLandofileLayers(replacement.appRoot);
    const target = layers.find((layer) => layer.filePath === replacement.targetFile);
    const ordered: readonly PresentLandofileLayer[] =
      target === undefined
        ? [
            ...layers,
            {
              filePath: replacement.targetFile,
              layer: "canonical",
              order: 3,
              basename: ".lando",
            } satisfies PresentLandofileLayer,
          ].sort((a, b) => a.order - b.order)
        : layers;
    const acquired = yield* Effect.forEach(ordered, (layer) =>
      prepareLandofileSource(
        layer.filePath,
        { ...runtime, layer: layer.layer },
        {
          ...inputs,
          sourceReplacement: layer.filePath === replacement.targetFile ? replacement : undefined,
        },
      ).pipe(
        Effect.catchTag("LandofileParseError", (error) =>
          Effect.fail(
            layer.filePath !== replacement.targetFile
              ? error
              : new LandofileWriteValidationError({
                  message: error.message,
                  file: error.filePath,
                  issues: [
                    {
                      ...validationIssue([], error.message),
                      source: { file: error.filePath, layer: layer.layer, path: [] },
                    },
                  ],
                  remediation:
                    "Fix the YAML syntax so the file parses, then retry. The file was left unchanged.",
                }),
          ),
        ),
        Effect.map((source) => ({ source, layer })),
      ),
    );
    const candidate = acquired.find(({ layer }) => layer.filePath === replacement.targetFile);
    if (candidate === undefined) return yield* Effect.die("Replacement source was not acquired.");
    const decoded = Schema.decodeUnknownResult(LandofileAuthoringFragmentNative)(candidate.source.value, {
      onExcessProperty: "error",
      errors: "all",
    });
    if (Result.isFailure(decoded)) {
      const error = validationErrorFromCause(replacement.targetFile, candidate.source.value, decoded.failure);
      return yield* Effect.fail(
        landofileValidationError(
          error.file,
          error.issues.map((issue) => ({
            ...issue,
            source: { file: candidate.source.file, layer: candidate.layer.layer, path: issue.path },
          })),
        ),
      );
    }
    const prepared = yield* Effect.forEach(acquired, ({ source, layer }) =>
      prepareLandofileValue(source).pipe(Effect.map(({ value }) => ({ layer, landofile: value }))),
    );
    const merged = yield* composePreparedLayers(prepared, runtime, inputs);
    yield* finalizeLandofile(join(replacement.appRoot, ".lando.yml"), merged, {
      appRoot: replacement.appRoot,
      overrides: inputs.overrides,
      pendingSites: runtime.pendingSites,
      loadPolicy: runtime.policy,
      logger: runtime.logger,
      ...(inputs?.templates.context?.env === undefined ? {} : { env: inputs.templates.context.env }),
    });
  },
  Effect.catchTag("LandofileValidationError", (error) =>
    Effect.fail(
      new LandofileWriteValidationError({
        message: error.message,
        file: error.file,
        issues: error.issues,
        remediation: "Fix the candidate or its effective overrides. The file was left unchanged.",
      }),
    ),
  ),
);
