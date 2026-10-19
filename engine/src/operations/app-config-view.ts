import { getLandofileIncludeSources } from "@lando/landofile/include-provenance";
import { getSourceDocuments } from "@lando/landofile/pipeline/source-table";
import { acquireLandofileRootLayers, composeLandofileRootLayers } from "@lando/landofile/service";
import { ConfigError, LandofileNotFoundError, LandofileWriteValidationError } from "@lando/sdk/errors";
import { encodeLandofileSourceValue } from "@lando/sdk/landofile";
import { LandofileShape, LandofileSourceValue, validationIssue } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { getAtPath } from "../config-write/dot-path.ts";
import { loadUserLandofile } from "../landofile/app-resolution.ts";
import {
  collectAuthoredRedactionTokens,
  collectLandofileRedactionTokens,
} from "../services/app-plan-redaction.ts";
import { findDiscoveredLandofilePath, scopedLandofileRuntimeInputs } from "../services/landofile-live.ts";

export interface AppConfigViewOptions {
  readonly source?: "raw" | "merged" | "resolved";
  readonly path?: string;
  readonly key?: string;
  readonly subcommand?: "view" | "get" | "set" | "unset" | "edit" | "validate";
  readonly cwd?: string;
}

const sourceValue = (value: unknown) =>
  Effect.try({
    try: () => encodeLandofileSourceValue(value),
    catch: (cause) =>
      new ConfigError({ message: "Landofile inspection requires serializable source data.", cause }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LandofileSourceValue)),
    Effect.mapError(
      (cause) =>
        new ConfigError({ message: "Landofile inspection requires serializable source data.", cause }),
    ),
  );

export const appConfigView = Effect.fn("AppOperation.configView")(function* (options: AppConfigViewOptions) {
  const source = options.source ?? "resolved";
  const selector = options.subcommand === "get" ? (options.key ?? options.path) : options.path;
  if (options.subcommand === "get" && selector === undefined)
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: "`app config get` requires a <key.path>.",
        file: "",
        issues: [validationIssue([], "Missing key path.")],
        remediation: "Usage: `lando app config get <key.path>`.",
      }),
    );
  const projection =
    selector === undefined
      ? {}
      : options.subcommand === "get"
        ? { subcommand: "get" as const, key: selector }
        : { path: selector };
  switch (source) {
    case "raw":
    case "merged": {
      const { appRoot } = yield* Effect.tryPromise({
        try: () => findDiscoveredLandofilePath(options.cwd ?? process.cwd()),
        catch: (cause) =>
          cause instanceof LandofileNotFoundError
            ? cause
            : new ConfigError({ message: "Failed to discover the app root.", cause }),
      });
      const inputs = yield* scopedLandofileRuntimeInputs;
      if (source === "raw") {
        const acquired = yield* acquireLandofileRootLayers(appRoot, inputs);
        const layers = yield* Effect.forEach(acquired.sources, ({ source, layer }) =>
          Effect.gen(function* () {
            const encoded = yield* sourceValue(source.value);
            const selected = selector === undefined ? encoded : getAtPath(encoded, selector);
            const document =
              selected === undefined
                ? undefined
                : yield* Schema.decodeUnknownEffect(LandofileSourceValue)(selected).pipe(Effect.orDie);
            return {
              layer: layer.layer,
              file: source.file,
              form: source.form,
              ...(document === undefined ? {} : { document }),
            };
          }),
        );
        const redactionTokens = acquired.sources.flatMap(({ source }) =>
          collectAuthoredRedactionTokens(source.value),
        );
        if (options.subcommand === "get")
          return {
            source,
            ...projection,
            redactionTokens,
            ...(layers.some((layer) => layer.document !== undefined) ? { value: layers } : {}),
          };
        return { source, ...projection, layers, redactionTokens };
      }
      const composed = yield* composeLandofileRootLayers(appRoot, inputs);
      const redactionTokens = composed.documents.flatMap((document) =>
        collectAuthoredRedactionTokens(document.document),
      );
      const landofile = yield* sourceValue(composed.merged);
      if (selector === undefined) return { source, landofile, redactionTokens };
      const selected = getAtPath(landofile, selector);
      return {
        source,
        ...projection,
        redactionTokens,
        ...(selected === undefined ? {} : { value: selected }),
      };
    }
    case "resolved": {
      const service = yield* LandofileService;
      const landofile = yield* loadUserLandofile(service);
      const metadata = {
        app: landofile.name ?? "",
        sources: getLandofileIncludeSources(landofile),
        redactionTokens: [
          ...collectLandofileRedactionTokens(landofile),
          ...getSourceDocuments(landofile).flatMap((document) =>
            collectAuthoredRedactionTokens(document.document),
          ),
        ],
      };
      if (selector === undefined) return { source, ...metadata, landofile };
      const selected = getAtPath(Schema.encodeSync(LandofileShape)(landofile), selector);
      return { source, ...metadata, ...projection, ...(selected === undefined ? {} : { value: selected }) };
    }
  }
});
