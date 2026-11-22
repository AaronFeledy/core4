import { authoredSourceDocument } from "@lando/landofile/authored-literal";
import { provenanceOf } from "@lando/landofile/provenance";
import {
  acquireLandofileRootLayers,
  composeLandofileRootLayers,
  finishLoadStage,
} from "@lando/landofile/service";
import { mapFailures } from "@lando/sdk/command-result";
import { ConfigError, LandofileWriteValidationError } from "@lando/sdk/errors";
import { encodeLandofileSourceValue } from "@lando/sdk/landofile";
import { LandofileShape, LandofileSourceValue, validationIssue } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { getAtPath } from "../config-write/dot-path.ts";
import { loadUserLandofile } from "../landofile/app-resolution.ts";
import {
  type LandofileRedactionValues,
  collectAuthoredRedactionTokens,
  mergeLandofileRedactionValues,
  registerLandofileRedaction,
  registerResolvedLandofileRedaction,
} from "../services/app-plan-redaction.ts";
import { findDiscoveredLandofilePath, scopedLandofileRuntimeInputs } from "../services/landofile-live.ts";

export const APP_CONFIG_SUBCOMMANDS = [
  "view",
  "get",
  "set",
  "unset",
  "edit",
  "validate",
  "describe",
] as const;

export interface AppConfigViewOptions {
  readonly source?: "raw" | "merged" | "resolved";
  readonly path?: string;
  readonly key?: string;
  readonly subcommand?: (typeof APP_CONFIG_SUBCOMMANDS)[number];
  readonly cwd?: string;
}

const inspectionValue = (value: unknown) =>
  Schema.decodeUnknownEffect(LandofileSourceValue)(value).pipe(
    mapFailures(
      (cause) =>
        new ConfigError({
          message: "Landofile inspection requires serializable source data.",
          cause,
          remediation:
            "Remove non-serializable values from the Landofile sources, then retry `lando app:config`.",
        }),
    ),
  );

const sourceValue = (value: unknown) =>
  Effect.try({
    try: () => encodeLandofileSourceValue(value),
    catch: (cause) =>
      new ConfigError({
        message: "Landofile inspection requires serializable source data.",
        cause,
        remediation:
          "Remove non-serializable values from the Landofile sources, then retry `lando app:config`.",
      }),
  }).pipe(Effect.flatMap(inspectionValue));

/** Register tiers; only substring values travel on the command result. */
const attachRedaction = Effect.fnUntraced(function* (...parts: LandofileRedactionValues[]) {
  const values = yield* registerLandofileRedaction(mergeLandofileRedactionValues(...parts));
  return values.substring;
});

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
      const { appRoot } = yield* findDiscoveredLandofilePath(options.cwd);
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
        const sourceValues = yield* Effect.forEach(acquired.sources, ({ source }) =>
          authoredSourceDocument({
            file: source.file,
            form: source.form,
            layer: source.context.layer,
            document: source.value,
            content: source.content,
            digest: source.digest,
          }).pipe(
            Effect.map((authored) => collectAuthoredRedactionTokens(authored.value, authored.provenance)),
            Effect.catchTag("LandofileValidationError", () =>
              Effect.succeed(collectAuthoredRedactionTokens(source.value, undefined)),
            ),
          ),
        );
        const redactionTokens = yield* attachRedaction(...sourceValues);
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
      if (composed.runtime.recorder !== undefined)
        yield* finishLoadStage(
          composed.sources.find(({ layer }) => layer.layer === "canonical")?.source.file ?? appRoot,
          composed.runtime.recorder,
        );
      const sourceValues = yield* Effect.forEach(composed.documents, (document) =>
        authoredSourceDocument(document).pipe(
          Effect.map((authored) => collectAuthoredRedactionTokens(authored.value, authored.provenance)),
        ),
      );
      const redactionTokens = yield* attachRedaction(...sourceValues);
      const landofile = yield* sourceValue(composed.merged.value);
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
      const loadedLandofile = yield* loadUserLandofile(service);
      const landofile = loadedLandofile.document;
      const provenance = provenanceOf(loadedLandofile);
      const { substring: redactionTokens } = yield* registerResolvedLandofileRedaction(loadedLandofile);
      const metadata = {
        app: landofile.name ?? "",
        sources: provenance?.includeSources ?? [],
        redactionTokens,
      };
      if (selector === undefined) return { source, ...metadata, landofile };
      const encoded = yield* Schema.encodeEffect(LandofileShape)(landofile, {
        onExcessProperty: "error",
      }).pipe(
        mapFailures(
          (cause) =>
            new ConfigError({
              message: "Cannot encode the resolved Landofile for inspection.",
              cause,
              remediation: "Run `lando app:config:lint` to check the Landofile and its sources.",
            }),
        ),
      );
      const selected = getAtPath(encoded, selector);
      return {
        source,
        ...metadata,
        ...projection,
        ...(selected === undefined ? {} : { value: yield* inspectionValue(selected) }),
      };
    }
  }
});
