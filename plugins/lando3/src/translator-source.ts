import { ConfigTranslateError } from "@lando/sdk/errors";
import { parseLegacyLandofile } from "@lando/sdk/landofile";
import type { ConfigTranslateDocument } from "@lando/sdk/schema";
import { Effect } from "effect";
import { LANDO3_TRANSLATOR_ID, type Lando3Source, type Lando3TranslatorPorts } from "./contract.ts";
import { sourceLayerForDocument } from "./detect.ts";
import { toMergedValue } from "./legacy-merge.ts";

const YAML_MEDIA_TYPES = new Set(["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"]);

export const translateError = (message: string, remediation: string): ConfigTranslateError =>
  new ConfigTranslateError({ message, translator: LANDO3_TRANSLATOR_ID, remediation });

export const parseSource =
  (ports: Lando3TranslatorPorts) =>
  (document: ConfigTranslateDocument): Effect.Effect<Lando3Source, ConfigTranslateError> =>
    Effect.gen(function* () {
      const file = document.path ?? String(document.sourceId);
      if (!YAML_MEDIA_TYPES.has(document.mediaType)) {
        return yield* Effect.fail(
          translateError(
            `${file} is ${document.mediaType}, which is not a Lando 3 Landofile.`,
            "Select only YAML Lando 3 layers for conversion.",
          ),
        );
      }
      const layer = sourceLayerForDocument(document);
      const parsed = yield* parseLegacyLandofile({
        mode: "legacy",
        file,
        content: new TextDecoder().decode(document.bytes),
      }).pipe(
        Effect.mapError((cause) =>
          translateError(
            // Parser messages quote source text, which may contain unknown credentials.
            ports.redactor.redactString(
              `Failed to read the Lando 3 layer ${file}${cause.line === undefined ? "" : ` at line ${cause.line}`}.`,
            ),
            `Repair ${file} and run the conversion again.`,
          ),
        ),
      );
      return {
        sourceId: document.sourceId,
        layer,
        file,
        value: toMergedValue({ document: parsed, sourceId: document.sourceId, layer }),
      };
    });
