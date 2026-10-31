import { existsSync } from "node:fs";
import { join } from "node:path";
import { LandofileFormConflictError, LandofileWriteValidationError } from "@lando/sdk/errors";
import { LandofileAuthoringFragmentNative, validationIssue } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { createIncludeResolutionSession } from "./include-session.ts";
import { type PresentLandofileLayer, landofileLayerPaths, presentLandofileLayers } from "./layers.ts";
import { assertReadableRoot, loadContext } from "./load-context.ts";
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

export const compileLandofileReplacement = Effect.fn("Landofile.compileReplacement")(
  function* (
    replacement: LandofileReplacement,
    inputs: LandofileRuntimeInputs & { readonly overrides?: LandofileFinalizeOverrides | undefined },
  ) {
    if (existsSync(replacement.appRoot)) yield* assertReadableRoot(replacement.appRoot, inputs);
    const layers = yield* presentLandofileLayers(replacement.appRoot);
    const target = layers.find((layer) => layer.filePath === replacement.targetFile);
    const position = landofileLayerPaths(replacement.appRoot).find(
      (layer) => layer.yamlPath === replacement.targetFile || layer.typescriptPath === replacement.targetFile,
    );
    if (
      target === undefined &&
      position !== undefined &&
      layers.some((layer) => layer.layer === position.layer)
    ) {
      return yield* Effect.fail(
        new LandofileFormConflictError({
          message: `The ${position.layer} Landofile layer already has another file form.`,
          layer: position.layer,
          yamlPath: position.yamlPath,
          typescriptPath: position.typescriptPath,
          remediation: "Keep exactly one YAML or TypeScript file for each Landofile layer, then retry.",
        }),
      );
    }
    const ordered: readonly PresentLandofileLayer[] =
      target === undefined
        ? [
            ...layers,
            {
              filePath: replacement.targetFile,
              layer: position?.layer ?? "canonical",
              order: position?.order ?? 3,
              basename: position?.basename ?? ".lando",
            } satisfies PresentLandofileLayer,
          ].sort((a, b) => a.order - b.order)
        : layers;
    const session = yield* createIncludeResolutionSession({ appRoot: replacement.appRoot, ...inputs });
    const runtime = yield* loadContext(replacement.appRoot, inputs.templates.context?.env);
    const acquired = yield* Effect.forEach(ordered, (layer) =>
      prepareLandofileSource(
        layer.filePath,
        { ...runtime, layer: layer.layer },
        {
          templates: inputs.templates,
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
    const merged = yield* composePreparedLayers(prepared, runtime, { session, inputs });
    const landofile = yield* finalizeLandofile(join(replacement.appRoot, ".lando.yml"), merged, {
      appRoot: replacement.appRoot,
      overrides: inputs.overrides,
      pendingSites: runtime.pendingSites,
      loadPolicy: runtime.policy,
      logger: runtime.logger,
      ...(inputs?.templates.context?.env === undefined ? {} : { env: inputs.templates.context.env }),
    });
    return { landofile, session };
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

export const validateLandofileReplacement = (
  replacement: LandofileReplacement,
  inputs: Parameters<typeof compileLandofileReplacement>[1],
) => compileLandofileReplacement(replacement, inputs).pipe(Effect.map(({ landofile }) => landofile));
