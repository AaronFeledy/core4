import { mergeLandofiles } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { rejectComposeKeys } from "./compose/rejections.ts";
import {
  getLandofileIncludeSources,
  getLocalIncludePaths,
  rememberLandofileIncludeSources,
  rememberLocalIncludePaths,
} from "./include-provenance.ts";
import {
  type LandofileRelaxedRead,
  resolveLandofileIncludeLayers,
  resolveLandofileIncludes,
} from "./includes.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { compileLandofileRootLayers } from "./root-compile.ts";
import { composeToolingIncludeEntries } from "./tooling-include-entries.ts";
import { validateLandofile } from "./validation.ts";
import { getVersionConstraintEntries, rememberVersionConstraintEntries } from "./version-constraint.ts";

export const mergeLandofileRootLayers = Effect.fnUntraced(function* (
  appRoot: string,
  canonicalPath: string,
  inputs?: LandofileRuntimeInputs,
) {
  const { compiled, scope, runtime } = yield* compileLandofileRootLayers(appRoot, canonicalPath, inputs);
  const logger = runtime.logger;
  const onRelaxedRead =
    logger === undefined
      ? undefined
      : (read: LandofileRelaxedRead) =>
          logger
            .info("Landofile load used outside-root policy override", {
              sourcePath: read.sourcePath,
              authoredPath: read.authoredPath,
              absolutePath: read.absolutePath,
              appRoot: read.appRoot,
            })
            .pipe(Effect.catch(() => Effect.void));
  const includeInputs = {
    appRoot,
    loadPolicy: runtime.policy,
    loadScope: scope,
    ...(inputs?.ports === undefined ? {} : { ports: inputs.ports }),
    ...(inputs?.stateStore === undefined ? {} : { stateStore: inputs.stateStore }),
    ...(onRelaxedRead === undefined ? {} : { onRelaxedRead }),
  };
  const loaded = yield* Effect.forEach(compiled, ({ layer, landofile }) =>
    resolveLandofileIncludeLayers({
      ...includeInputs,
      landofile,
      sourcePath: layer.filePath,
      layer: layer.layer,
      order: layer.order,
      resolveTooling: false,
    }).pipe(
      Effect.map((resolved) => ({ layer, landofile: resolved.provenance, overlays: resolved.overlays })),
    ),
  );
  const overlays = loaded.flatMap(({ overlays }) => overlays);
  const composedTooling = composeToolingIncludeEntries(overlays);
  const merged = {
    ...mergeLandofiles(overlays),
    ...(composedTooling.length === 0 ? {} : { includes: composedTooling }),
  };
  const decoded = yield* rejectComposeKeys(canonicalPath, merged).pipe(
    Effect.flatMap((parsed) => validateLandofile(canonicalPath, parsed)),
  );
  const landofile = rememberLandofileAppRoot(
    rememberLandofileIncludeSources(
      rememberLocalIncludePaths(
        rememberVersionConstraintEntries(
          decoded,
          loaded.flatMap(({ landofile, layer }) => getVersionConstraintEntries(landofile, layer.filePath)),
        ),
        loaded.flatMap(({ landofile }) => getLocalIncludePaths(landofile)),
      ),
      loaded.flatMap(({ landofile }) => getLandofileIncludeSources(landofile)),
    ),
    appRoot,
  );
  const resolved = yield* resolveLandofileIncludes({
    ...includeInputs,
    landofile,
    sourcePath: canonicalPath,
  });
  return rememberLandofileReferencedFiles(resolved, [
    ...getLandofileReferencedFiles(resolved),
    ...loaded.flatMap(({ landofile }) => getLandofileReferencedFiles(landofile)),
  ]);
});
