import { dirname } from "node:path";
import { mergeLandofiles } from "@lando/sdk/landofile";
import type { LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { type LandofileLoadScope, buildLandofileLoadScope } from "./compile.ts";
import { legacyLoadFailure } from "./legacy-load-failure.ts";
import type { LandofileLoadContext } from "./load-context.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { type LandofileCompileError, compilePreparedLayer } from "./root-compile.ts";
import { prepareLandofileLayer } from "./source.ts";
import { validateLandofile } from "./validation.ts";

export const compileLandofileFile = Effect.fn("Landofile.compileFile")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: LandofileRuntimeInputs,
  scope?: LandofileLoadScope,
): Effect.fn.Return<
  { readonly landofile: LandofileShape; readonly scope: LandofileLoadScope },
  LandofileCompileError
> {
  const prepared = yield* prepareLandofileLayer(filePath, context, inputs);
  const loadScope =
    scope ??
    (yield* buildLandofileLoadScope([prepared], inputs?.templates.context?.env).pipe(
      Effect.catch((error) =>
        prepared.content === undefined
          ? Effect.fail(error)
          : legacyLoadFailure(error, prepared.content, { ...prepared.context, sourceFile: filePath }),
      ),
    ));
  const overlay = yield* compilePreparedLayer(prepared, loadScope);
  const decoded = yield* validateLandofile(filePath, mergeLandofiles([overlay]));
  const landofile = rememberLandofileAppRoot(
    rememberLandofileReferencedFiles(decoded, getLandofileReferencedFiles(overlay)),
    context?.appRoot ?? dirname(filePath),
  );
  return { landofile, scope: loadScope };
});
