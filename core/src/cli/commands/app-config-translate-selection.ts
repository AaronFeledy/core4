import { detectConfigTranslators } from "@lando/landofile/config-translate";
import { ConfigTranslateError } from "@lando/sdk/errors";
import type { ConfigTranslateDocument } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { Effect } from "effect";

const fromRemediation = (translators: ReadonlyArray<ConfigTranslatorShape>): string =>
  `Choose an explicit translator with one of: ${translators.map((translator) => `--from ${translator.id}`).join(", ")}.`;

export const selectTranslator = (
  translators: ReadonlyArray<ConfigTranslatorShape>,
  from: string | undefined,
  documents: ReadonlyArray<ConfigTranslateDocument>,
) =>
  Effect.gen(function* () {
    if (from !== undefined) {
      const forced = translators.find((translator) => translator.id === from);
      if (forced === undefined)
        return yield* Effect.fail(
          new ConfigTranslateError({
            message: `No config translator with id "${from}" is registered.`,
            remediation: fromRemediation(translators),
          }),
        );
      return forced;
    }
    const matches = yield* detectConfigTranslators(translators, { documents });
    const ids = new Set(
      matches
        .filter((match) => match.confidence === "exact" || match.confidence === "likely")
        .map((match) => match.translator),
    );
    const candidates = translators.filter((translator) => ids.has(translator.id));
    if (candidates.length > 1)
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: `Config translation is ambiguous: ${[...ids].join(", ")} all detected the source.`,
          remediation: fromRemediation(candidates),
        }),
      );
    const selected = candidates[0];
    if (selected === undefined)
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: "No config translator detected a supported source file under the app root.",
          remediation: `${fromRemediation(translators)} Scope the input files with --file <path> when a translator cannot autodetect.`,
        }),
      );
    return selected;
  });
