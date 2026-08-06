import { Effect } from "effect";

import { type ConfigTranslateError, ConfigTranslatorConflictError } from "@lando/sdk/errors";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateDiagnostic,
  ConfigTranslateInput,
  ConfigTranslateMatch,
  ConfigTranslateResult,
  ConfigTranslatorShape,
  LandofileFragment,
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
    for (const translator of resolved) {
      matches.push(...(yield* translator.detect(input)));
    }
    return matches;
  });

export const runConfigTranslators = (
  translators: ReadonlyArray<ConfigTranslatorShape>,
  input: ConfigTranslateInput,
): Effect.Effect<ConfigTranslateResult, ConfigTranslateError | ConfigTranslatorConflictError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveConfigTranslators(translators);
    let fragment: LandofileFragment = {};
    const diagnostics: Array<ConfigTranslateDiagnostic> = [];
    for (const translator of resolved) {
      const result = yield* translator.translate(input);
      fragment = { ...fragment, ...result.fragment };
      diagnostics.push(...result.diagnostics);
    }
    return { fragment, diagnostics };
  });
