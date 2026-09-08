import { join } from "node:path";
import { makeConfigTranslatorRegistryLive } from "@lando/engine/plugins/config-translator-registry";
import { runConfigTranslator } from "@lando/landofile/config-translate";
import { mergeLandofiles } from "@lando/landofile/merge";
import { type TransactionOptions, makeManagedFileTransactions } from "@lando/managed-file/transaction";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { validateRecipeSecretPrompts } from "@lando/sdk/recipes";
import {
  type ConfigTranslateDiagnostic,
  ConfigTranslateRecipeRequestInput,
  LandofileAuthoringFragment,
  type RecipeManifest,
} from "@lando/sdk/schema";
import { REDACTED } from "@lando/sdk/secrets";
import {
  ConfigTranslatorRegistry,
  type ConfigTranslatorShape,
  type RecipeDecomposerFactory,
} from "@lando/sdk/services";
import { Effect, Either, Option, Schema } from "effect";
import { RECIPE_TRANSLATOR_ID } from "./config-translator.ts";
import { auxiliaryDestination, writeAuxiliaryScaffold } from "./init-pipeline/files.ts";
import { runBoundPostInit } from "./init-pipeline/post-init.ts";
import { containsSecretValue, secretReference } from "./init-pipeline/secrets.ts";
import type { PostInitOutcome, RunPostInitOptions } from "./post-init/runtime.ts";
import { makeRecipeTranslatorModule } from "./translator-module.ts";

export class RecipeInitBlockedError extends Schema.TaggedError<RecipeInitBlockedError>()(
  "RecipeInitBlockedError",
  {
    message: Schema.String,
    stage: Schema.Literal("secret-prompts", "translate", "validate", "encode", "diagnostics"),
    remediation: Schema.String,
  },
) {}
export class RecipeInitCommitError extends Schema.TaggedError<RecipeInitCommitError>()(
  "RecipeInitCommitError",
  {
    message: Schema.String,
    remediation: Schema.String,
    phase: Schema.String,
    reason: Schema.String,
  },
) {}
export class RecipeInitPostInitError extends Schema.TaggedError<RecipeInitPostInitError>()(
  "RecipeInitPostInitError",
  {
    message: Schema.String,
    remediation: Schema.String,
    committedLandofile: Schema.String,
    committedAuxiliaryFiles: Schema.Array(Schema.String),
    failedAction: Schema.String,
    rolledBack: Schema.Literal(false),
  },
) {}

export interface RecipeInitPipelineRequest {
  readonly appRoot: string;
  readonly landofileBasename?: string;
  readonly manifest: RecipeManifest;
  readonly decomposer: RecipeDecomposerFactory;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly secretAnswers?: Readonly<Record<string, string>>;
  readonly appName: string;
  readonly encoder: ConfigTranslatorShape;
  readonly journalRoot: () => string;
  readonly checkpoint?: NonNullable<TransactionOptions["checkpoint"]>;
  readonly runPostInit?: (options: RunPostInitOptions) => Promise<PostInitOutcome>;
  readonly writeAuxiliaryFile?: (path: string, content: string) => Promise<void>;
}
export interface RecipeInitPipelineResult {
  readonly landofilePath: string;
  readonly auxiliaryFiles: ReadonlyArray<string>;
  readonly backups: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
  readonly postInit: PostInitOutcome;
}

const blocked = (stage: RecipeInitBlockedError["stage"]) =>
  new RecipeInitBlockedError({
    stage,
    message: `Recipe initialization blocked at ${stage}; no scaffold was written.`,
    remediation: "Correct the recipe inputs, translator, or encoder before retrying initialization.",
  });

export const runRecipeInitPipeline = (
  request: RecipeInitPipelineRequest,
): Effect.Effect<
  RecipeInitPipelineResult,
  RecipeInitBlockedError | RecipeInitCommitError | RecipeInitPostInitError,
  never
> =>
  Effect.gen(function* () {
    const validated = validateRecipeSecretPrompts(request.manifest);
    if (Either.isLeft(validated)) return yield* Effect.fail(blocked("secret-prompts"));
    const raw = Object.values(request.secretAnswers ?? {}).filter((value) => value.length > 0);
    const containsSecret = (value: unknown) => containsSecretValue(raw, value);
    if (
      containsSecret([
        request.answers,
        request.manifest,
        request.appRoot,
        request.appName,
        request.landofileBasename,
      ]) ||
      validated.right.some(({ promptName }) => Object.hasOwn(request.answers, promptName))
    ) {
      return yield* Effect.fail(blocked("secret-prompts"));
    }
    const references = Object.fromEntries(
      validated.right.map(({ promptName, disposition }) => [promptName, secretReference(disposition)]),
    );
    const input = yield* Schema.decodeUnknown(ConfigTranslateRecipeRequestInput)({
      _tag: "recipe-request",
      recipe: { id: request.manifest.id, version: request.manifest.version },
      sourceId: `recipe:${request.manifest.id}@${request.manifest.version}`,
      answers: request.answers,
      secretAnswers: references,
    }).pipe(Effect.mapError(() => blocked("translate")));
    const service = yield* Effect.serviceOption(RedactionService);
    const options = { redactionTokens: raw };
    const base = Option.isSome(service)
      ? yield* service.value.forProfile("secrets", options)
      : createStandaloneRedactor("secrets", options);
    // Exact masking also covers short values intentionally excluded by profile heuristics.
    const tokens = [...new Set(raw)].sort((left, right) => right.length - left.length);
    const redact = (text: string) =>
      base.redactString(tokens.reduce((text, secret) => text.replaceAll(secret, REDACTED), text));
    const redactor = { ...base, redactString: redact };
    const module = yield* Effect.try({
      try: () =>
        makeRecipeTranslatorModule({
          decomposers: new Map([[request.manifest.id, request.decomposer]]),
          redactor,
        }),
      catch: () => blocked("translate"),
    });
    const translators = yield* Effect.flatMap(ConfigTranslatorRegistry, (registry) => registry.list).pipe(
      Effect.provide(makeConfigTranslatorRegistryLive([module])),
      Effect.mapError(() => blocked("translate")),
    );
    const translator = translators.find(({ id }) => id === RECIPE_TRANSLATOR_ID);
    if (translator === undefined) return yield* Effect.fail(blocked("translate"));
    const translated = yield* Effect.suspend(() => runConfigTranslator(translator, input)).pipe(
      Effect.catchAll(() => Effect.fail(blocked("translate"))),
    );
    const output = translated.outputs[0];
    if (translated.outputs.length !== 1 || output?.targetLayer !== "canonical")
      return yield* Effect.fail(blocked("validate"));
    const mapping = yield* Schema.decodeUnknown(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
      output.fragment,
    ).pipe(Effect.mapError(() => blocked("validate")));
    const context = mergeLandofiles([mapping, { name: request.appName }]);
    yield* Schema.decodeUnknown(LandofileAuthoringFragment)(context, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => blocked("validate")),
    );
    if (containsSecret(context)) return yield* Effect.fail(blocked("validate"));
    const encode = request.encoder.encode;
    if (encode === undefined) return yield* Effect.fail(blocked("encode"));
    const encoded = yield* Effect.suspend(() => encode({ context, fragment: context })).pipe(
      Effect.catchAll(() => Effect.fail(blocked("encode"))),
    );
    const diagnostics = [...translated.diagnostics, ...encoded.diagnostics].map((diagnostic) => ({
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
    const basename = request.landofileBasename ?? ".lando.yml";
    const landofilePath = join(request.appRoot, basename);
    yield* Effect.try({
      try: () => {
        for (const file of request.manifest.files ?? []) auxiliaryDestination(request.appRoot, file.dest);
      },
      catch: () => blocked("validate"),
    });
    const receipt = yield* makeManagedFileTransactions({
      journalRoot: request.journalRoot,
      ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
    })
      .run({
        appRoot: request.appRoot,
        operations: [{ kind: "write", path: basename, content: encoded.text }],
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new RecipeInitCommitError({
              phase: error.phase,
              reason: error.reason,
              message: `Recipe scaffold transaction failed (${error.phase}/${error.reason}).`,
              remediation: redact(error.remediation),
            }),
        ),
      );
    const auxiliaryFiles: string[] = [];
    const postFailure = (failedAction: string) =>
      new RecipeInitPostInitError({
        message: `Recipe action ${failedAction} failed; the committed scaffold was kept. External side effects were NOT rolled back.`,
        remediation:
          "The committed scaffold was kept and external side effects were NOT rolled back. Inspect the named action and committed files before retrying.",
        committedLandofile: landofilePath,
        committedAuxiliaryFiles: [...auxiliaryFiles],
        failedAction,
        rolledBack: false,
      });
    for (const [index, file] of (request.manifest.files ?? []).entries()) {
      const path = yield* Effect.tryPromise({
        try: () =>
          writeAuxiliaryScaffold({
            appRoot: request.appRoot,
            file,
            containsSecret,
            ...(request.writeAuxiliaryFile === undefined ? {} : { write: request.writeAuxiliaryFile }),
          }),
        catch: () => postFailure(`files[${index}]`),
      });
      if (path !== undefined) auxiliaryFiles.push(path);
    }
    const postInit = yield* runBoundPostInit({ request, redact, postFailure });
    return {
      landofilePath,
      auxiliaryFiles,
      backups: receipt.backups.map((path) => join(request.appRoot, path)),
      diagnostics,
      postInit,
    };
  });
