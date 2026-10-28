import {
  assessTranslateExpectations,
  orderTranslateDiagnostics,
} from "@lando/engine/planner/home-expectations";
import * as ConfigTranslatorRegistryLayer from "@lando/engine/plugins/config-translator-registry";
import { runConfigTranslator } from "@lando/landofile/config-translate";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { containsReservedBinding } from "@lando/sdk/expressions";
import { mergeLandofiles } from "@lando/sdk/landofile";
import { validateRecipeSecretPrompts } from "@lando/sdk/recipes";
import {
  ConfigTranslateRecipeRequestInput,
  LandofileAuthoringFragment,
  LandofileAuthoringFragmentNative,
} from "@lando/sdk/schema";
import { REDACTED } from "@lando/sdk/secrets";
import { ConfigTranslatorRegistry } from "@lando/sdk/services";
import { Effect, Option, Result, Schema } from "effect";
import { RECIPE_TRANSLATOR_ID } from "../config-translator.ts";
import type { RecipeLandofilePreviewRequest } from "../init-pipeline.ts";
import { makeRecipeTranslatorModule } from "../translator-module.ts";
import { RecipeInitBlockedError, blocked } from "./errors.ts";
import { containsSecretValue, secretReference } from "./secrets.ts";

export const encodeRecipeLandofile = Effect.fnUntraced(function* (
  request: RecipeLandofilePreviewRequest & { readonly landofileBasename?: string },
) {
  const validated = validateRecipeSecretPrompts(request.manifest);
  if (Result.isFailure(validated)) return yield* Effect.fail(blocked("secret-prompts"));
  const raw = validated.success
    .filter(({ disposition }) => disposition.kind === "init-only")
    .map(({ promptName }) => request.secretAnswers?.[promptName])
    .filter((value): value is string => value !== undefined && value.length > 0);
  const containsSecret = (value: unknown) => containsSecretValue(raw, value);
  if (
    containsSecret([
      request.answers,
      request.manifest,
      request.appRoot,
      request.appName,
      request.landofileBasename,
    ]) ||
    validated.success.some(({ promptName }) => Object.hasOwn(request.answers, promptName))
  )
    return yield* Effect.fail(blocked("secret-prompts"));
  const references = yield* Effect.try({
    try: () =>
      Object.fromEntries(
        validated.success.map(({ promptName, disposition }) => [
          promptName,
          secretReference(disposition, request.secretAnswers?.[promptName]),
        ]),
      ),
    catch: () => blocked("secret-prompts"),
  });
  const input = yield* Schema.decodeUnknownEffect(ConfigTranslateRecipeRequestInput)({
    _tag: "recipe-request",
    recipe: { id: request.manifest.id, version: request.manifest.version },
    sourceId: `recipe:${request.manifest.id}@${request.manifest.version}`,
    answers: request.answers,
    secretAnswers: references,
  }).pipe(Effect.mapError(() => blocked("translate")));
  const service = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(service)) yield* service.value.registerValues(raw);
  const options = { redactionTokens: raw, sourceEnv: { ...process.env } };
  const base = Option.isSome(service)
    ? yield* service.value.forProfile("secrets", options)
    : createStandaloneRedactor("secrets", options);
  const tokens = [...new Set(raw)].sort((left, right) => right.length - left.length);
  const redact = (text: string) =>
    base.redactString(tokens.reduce((text, secret) => text.replaceAll(secret, REDACTED), text));
  const module = yield* Effect.try({
    try: () =>
      makeRecipeTranslatorModule({
        decomposers: new Map([[request.manifest.id, request.decomposer]]),
        redactor: { ...base, redactString: redact },
      }),
    catch: () => blocked("translate"),
  });
  const translators = yield* Effect.flatMap(ConfigTranslatorRegistry, (registry) => registry.list).pipe(
    Effect.provide(ConfigTranslatorRegistryLayer.layerWith([module])),
    Effect.mapError(() => blocked("translate")),
  );
  const translator = translators.find(({ id }) => id === RECIPE_TRANSLATOR_ID);
  if (translator === undefined) return yield* Effect.fail(blocked("translate"));
  const translated = yield* Effect.suspend(() => runConfigTranslator(translator, input)).pipe(
    Effect.mapError(
      (error) =>
        new RecipeInitBlockedError({
          stage: "translate",
          message: error.message,
          remediation: error.remediation,
        }),
    ),
  );
  const output = translated.outputs[0];
  if (translated.outputs.length !== 1 || output?.targetLayer !== "canonical")
    return yield* Effect.fail(blocked("validate"));
  const mapping = yield* Schema.decodeUnknownEffect(LandofileAuthoringFragment)(output.fragment).pipe(
    Effect.flatMap((value) => Schema.encodeEffect(LandofileAuthoringFragmentNative)(value)),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))),
    Effect.mapError(() => blocked("validate")),
  );
  if (containsReservedBinding(mapping)) return yield* Effect.fail(blocked("validate"));
  const context = mergeLandofiles([mapping, { name: request.appName }]);
  yield* Schema.decodeUnknownEffect(LandofileAuthoringFragment)(context, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => blocked("validate")),
  );
  if (containsSecret(context)) return yield* Effect.fail(blocked("validate"));
  const encode = request.encoder.encode;
  if (encode === undefined) return yield* Effect.fail(blocked("encode"));
  const encoded = yield* Effect.suspend(() => encode({ context, fragment: context })).pipe(
    Effect.catch(() => Effect.fail(blocked("encode"))),
  );
  const assessmentDiagnostics = yield* assessTranslateExpectations(translated.expectations, context);
  const diagnostics = orderTranslateDiagnostics(
    [...translated.diagnostics, ...encoded.diagnostics, ...assessmentDiagnostics],
    [input.sourceId],
  ).map((diagnostic) => ({
    ...diagnostic,
    message: redact(diagnostic.message),
    ...(diagnostic.remediation === undefined ? {} : { remediation: redact(diagnostic.remediation) }),
  }));
  if (
    diagnostics.some(({ kind }) => kind === "unsupported" || kind === "non-portable") ||
    containsSecret(diagnostics)
  )
    return yield* Effect.fail(blocked("diagnostics"));
  if (containsSecret(encoded.text)) return yield* Effect.fail(blocked("encode"));
  return { text: encoded.text, diagnostics, redact, containsSecret };
});
