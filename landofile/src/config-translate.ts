import { Effect } from "effect";

import { ConfigTranslateError, ConfigTranslatorConflictError } from "@lando/sdk/errors";
import { validateConfigTranslateInput, validateConfigTranslateResult } from "@lando/sdk/landofile";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateInput,
  ConfigTranslateMatch,
  ConfigTranslateResult,
  ConfigTranslatorShape,
} from "@lando/sdk/services";

export const resolveConfigTranslators = (
  translators: ReadonlyArray<ConfigTranslatorShape>,
): Effect.Effect<ReadonlyArray<ConfigTranslatorShape>, ConfigTranslatorConflictError> => {
  const orderedIds: Array<string> = [];
  const countById = new Map<string, number>();
  for (const translator of translators) {
    const count = countById.get(translator.id) ?? 0;
    if (count === 0) orderedIds.push(translator.id);
    countById.set(translator.id, count + 1);
  }

  const conflictId = orderedIds.find((id) => (countById.get(id) ?? 0) > 1);
  if (conflictId !== undefined) {
    const conflicting = translators
      .filter((translator) => translator.id === conflictId)
      .map((translator) => translator.summary || translator.id);
    return Effect.fail(
      new ConfigTranslatorConflictError({
        message: `Config translator id ${conflictId} is declared by ${conflicting.length} translators.`,
        id: conflictId,
        translators: conflicting,
        remediation: `Remove or rename one of the conflicting translators so only one declares id ${conflictId}.`,
      }),
    );
  }

  return Effect.succeed(translators);
};

export const detectConfigTranslators = (
  translators: ReadonlyArray<ConfigTranslatorShape>,
  input: ConfigTranslateDetectInput,
): Effect.Effect<ReadonlyArray<ConfigTranslateMatch>, ConfigTranslateError | ConfigTranslatorConflictError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveConfigTranslators(translators);
    const matches: Array<ConfigTranslateMatch> = [];
    const sourceIds = new Set(input.documents.map((document) => document.sourceId));
    for (const translator of resolved) {
      const detected = yield* translator.detect(input);
      if (
        detected.some(
          (match) => match.translator !== translator.id || match.sourceIds.some((id) => !sourceIds.has(id)),
        )
      ) {
        return yield* Effect.fail(
          new ConfigTranslateError({
            translator: translator.id,
            message: "Detection returned a foreign translator or source identity.",
            remediation:
              "Attribute matches to the producing translator and only sources in the input documents.",
          }),
        );
      }
      matches.push(...detected);
    }
    return matches;
  });

export const runConfigTranslator = (
  translator: ConfigTranslatorShape,
  input: ConfigTranslateInput,
): Effect.Effect<ConfigTranslateResult, ConfigTranslateError> =>
  Effect.gen(function* () {
    const validated = yield* validateConfigTranslateInput(input);
    const result = yield* translator.translate(validated);
    return yield* validateConfigTranslateResult(validated, result);
  }).pipe(
    Effect.mapError(
      (error) => new ConfigTranslateError({ ...error, message: error.message, translator: translator.id }),
    ),
  );
