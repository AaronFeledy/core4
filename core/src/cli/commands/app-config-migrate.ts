import { join } from "node:path";
import { parseLandofile } from "@lando/landofile/parser";
import { LandofileNotFoundError } from "@lando/sdk/errors";
import {
  isBareRecipeReference,
  renderRecipeSnapshot,
  validateLandofileRecipeProvenance,
} from "@lando/sdk/recipes";
import {
  type RecipeMigration,
  type RecipeMigrationHunk,
  type RecipeProducer,
  type RecipeSnapshot,
  recipeVersionedKey,
  sameRecipeFamily,
  sameRecipeVersion,
} from "@lando/sdk/schema";
import { InteractionService, ManagedFileTransactionGuard } from "@lando/sdk/services";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Either, Option, Schema } from "effect";
import { BUILTIN_RECIPE_SNAPSHOTS } from "../../recipes/builtin/snapshots.ts";
import { analyzeRecipeMigration } from "./app-config-migrate-analysis.ts";
import type { AppConfigMigrateResult, MigrateBlockedReason } from "./app-config-migrate-output.ts";
import {
  AppConfigMigrateCommitError,
  AppConfigMigrateError,
  honorMigrationJournal,
  writeRecipeMigration,
} from "./app-config-migrate-write.ts";
import {
  CANONICAL_LANDOFILE,
  PROGRAMMATIC_LANDOFILE,
  discoverRecipeAnalysisRoot,
  generatedServiceNames,
  provenanceWithoutServiceMap,
} from "./app-config-recipe-analysis.ts";

export {
  AppConfigMigrateResultSchema,
  MigrateBlockedReason,
  MigrateHunkBlockReason,
  renderAppConfigMigrateResult,
} from "./app-config-migrate-output.ts";
export type { AppConfigMigrateResult } from "./app-config-migrate-output.ts";
export { AppConfigMigrateError, AppConfigMigrateCommitError } from "./app-config-migrate-write.ts";

export interface AppConfigMigrateOptions {
  readonly cwd?: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly nonInteractive?: boolean;
  readonly privateFileAccess?: PrivateFileAccess;
  readonly recipes?: ReadonlyMap<
    string,
    { readonly snapshot: RecipeSnapshot; readonly migrations: ReadonlyArray<RecipeMigration> }
  >;
}

const bundledRecipes = new Map(
  [...BUILTIN_RECIPE_SNAPSHOTS].map(([id, snapshot]) => [id, { snapshot, migrations: [] }]),
);
// Opaque input has no resolvable target. Never claim it belongs to a bundled recipe.
const unresolvedTarget: RecipeProducer = {
  sourceKind: "local",
  packageName: "unresolved",
  recipeId: "unresolved",
  manifestVersion: "0.0.0",
  contentDigest: `sha256:${"0".repeat(64)}`,
};

export const appConfigMigrate = (options: AppConfigMigrateOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = options.cwd ?? process.cwd();
      const { appRoot, dualForm } = yield* Effect.tryPromise({
        try: () => discoverRecipeAnalysisRoot(cwd),
        catch: (cause) =>
          cause instanceof LandofileNotFoundError
            ? cause
            : new LandofileNotFoundError({ message: "Cannot discover the app Landofile.", cwd }),
      });
      const guard = yield* Effect.serviceOption(ManagedFileTransactionGuard);
      if (Option.isSome(guard)) yield* honorMigrationJournal(guard.value, appRoot, options.dryRun === true);
      const landofilePath = join(appRoot, CANONICAL_LANDOFILE);
      const programmaticPath = join(appRoot, PROGRAMMATIC_LANDOFILE);
      const recipes = options.recipes ?? bundledRecipes;
      const mode = options.dryRun ? "dry-run" : "write";
      const blocked = (
        reason: MigrateBlockedReason,
        detail: string,
        target = unresolvedTarget,
      ): AppConfigMigrateResult => ({
        mode,
        status: "blocked",
        landofilePath,
        target,
        edges: [],
        next: "",
        blocked: {
          reason,
          detail,
          remediation:
            "Restore canonical YAML with valid recipe provenance and an injective service map; remove includes before retrying.",
        },
      });
      const programmatic = dualForm || (yield* Effect.promise(() => Bun.file(programmaticPath).exists()));
      if (programmatic) return blocked("programmatic-landofile", "TypeScript is opaque; never executed.");
      const originalBytes = yield* Effect.tryPromise({
        try: () => Bun.file(landofilePath).bytes(),
        catch: () => "Cannot read the canonical Landofile.",
      }).pipe(Effect.either);
      if (Either.isLeft(originalBytes)) return blocked("invalid-provenance", "Canonical YAML is unreadable.");
      const parsed = yield* parseLandofile({
        file: landofilePath,
        content: new TextDecoder().decode(originalBytes.right),
        cwd: appRoot,
      }).pipe(Effect.either);
      if (Either.isLeft(parsed)) return blocked("invalid-provenance", "Canonical YAML is unreadable.");
      const document: Record<string, unknown> = yield* Schema.decodeUnknown(
        Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      )(parsed.right).pipe(Effect.orElseSucceed(() => ({})));
      const validated = validateLandofileRecipeProvenance(document.recipe);
      const facts = provenanceWithoutServiceMap(document.recipe);
      const target =
        facts === undefined ? unresolvedTarget : (recipes.get(facts.id)?.snapshot.identity ?? facts.producer);
      if (document.includes !== undefined)
        return blocked("includes-present", "Included documents are never followed for migration.", target);
      if (Either.isLeft(validated))
        return blocked(
          facts === undefined ? "invalid-provenance" : "invalid-service-map",
          "Recipe provenance or its service map is invalid.",
          target,
        );
      if (isBareRecipeReference(validated.right)) {
        const source = recipes.get(validated.right);
        return blocked(
          source === undefined ? "unknown-recipe" : "bare-provenance",
          "A recipe id alone does not identify the producer or its options.",
          source?.snapshot.identity,
        );
      }
      const provenance = validated.right;
      const source = recipes.get(provenance.id);
      if (source === undefined)
        return yield* new AppConfigMigrateError({
          reason: "unknown-recipe",
          message: "The recorded recipe is absent from the migration source.",
          remediation: "Install the recorded recipe producer before retrying.",
        });
      if (!sameRecipeFamily(provenance.producer, source.snapshot.identity))
        return yield* new AppConfigMigrateError({
          reason: "identity-mismatch",
          message: "The recorded and target producers belong to different recipe families.",
          remediation: "Restore the recorded recipe source; migration cannot cross producer families.",
        });
      const oldSnapshot =
        source.migrations.find((edge) => sameRecipeVersion(edge.from, provenance.producer))?.fromSnapshot ??
        (sameRecipeVersion(provenance.producer, source.snapshot.identity) ? source.snapshot : undefined);
      if (oldSnapshot !== undefined && provenance.services !== undefined) {
        const rendered = renderRecipeSnapshot(oldSnapshot, provenance.options);
        if (Either.isRight(rendered)) {
          const names = generatedServiceNames(rendered.right);
          const mappings = provenance.services;
          const destinations = [...names].map((name) => mappings[name] ?? name);
          const renamed = new Map(
            source.migrations.flatMap((edge) =>
              edge.hunks.flatMap((hunk) =>
                hunk.kind === "rename" &&
                /^services\.[^.\[]+$/.test(hunk.old) &&
                /^services\.[^.\[]+$/.test(hunk.new)
                  ? [[hunk.old.slice(9), hunk.new.slice(9)] as const]
                  : [],
              ),
            ),
          );
          if (
            Object.entries(mappings).some(
              ([name, current]) => !names.has(name) && !(renamed.get(name) === current && names.has(current)),
            ) ||
            new Set(destinations).size !== destinations.length
          )
            return blocked(
              "invalid-service-map",
              "Service mappings must name generated services without merging destinations.",
              target,
            );
        }
      }
      const input = { document, provenance, target: source.snapshot, migrations: source.migrations };
      const selectable: RecipeMigrationHunk[] = [];
      // Both passes are pure and in-memory. Collect answers before replaying the synchronous decision seam.
      let analysis = analyzeRecipeMigration({
        ...input,
        decide: (hunk) => {
          selectable.push(hunk);
          return true;
        },
      });
      if (!options.dryRun && !options.yes && selectable.length > 0) {
        const interaction = yield* Effect.serviceOption(InteractionService);
        if (options.nonInteractive || Option.isNone(interaction) || !(yield* interaction.value.isInteractive))
          return yield* Effect.fail(
            new AppConfigMigrateError({
              reason: "confirmation-required",
              message: "Migration requires explicit hunk approval.",
              remediation: "Review --dry-run, then re-run with --yes in non-interactive mode.",
            }),
          );
        const answers = new Map<string, boolean>();
        for (const hunk of selectable)
          answers.set(
            hunk.id,
            yield* interaction.value.confirm({
              name: hunk.id,
              message: `Apply ${hunk.kind} at ${hunk.path}?`,
              default: false,
            }),
          );
        analysis = analyzeRecipeMigration({ ...input, decide: (hunk) => answers.get(hunk.id) === true });
      }
      if (analysis.noMutation === "identity-mismatch")
        return yield* Effect.fail(
          new AppConfigMigrateError({
            reason: "identity-mismatch",
            message: "The recorded producer cannot be migrated to this target.",
            remediation: "Restore the matching recipe source before retrying.",
          }),
        );
      if (!options.dryRun && analysis.committed !== undefined) {
        if (options.privateFileAccess === undefined) {
          return yield* Effect.fail(
            new AppConfigMigrateCommitError({
              message: "Private file access is unavailable for the migration commit.",
              phase: "prepare",
              reason: "private-file-access-unavailable",
              remediation: "Run the migration through the Lando runtime.",
            }),
          );
        }
        yield* writeRecipeMigration({
          appRoot,
          document: analysis.document,
          expectedBefore: originalBytes.right,
          privateFileAccess: options.privateFileAccess,
        });
      }
      let precedingBlock = false;
      const edges: AppConfigMigrateResult["edges"] = analysis.edges.map((edge) => {
        const status = precedingBlock ? "skipped" : edge.status === "satisfied" ? "satisfied" : "blocked";
        precedingBlock ||= edge.status === "blocking";
        return {
          from: recipeVersionedKey(edge.from),
          to: recipeVersionedKey(edge.to),
          status,
          hunks: edge.hunks,
        };
      });
      return {
        mode,
        landofilePath,
        target: source.snapshot.identity,
        recorded: provenance.producer,
        edges,
        status:
          analysis.committed === undefined
            ? analysis.status === "no-mutation"
              ? "no-op"
              : "blocked"
            : analysis.status === "blocking"
              ? "partial"
              : "committed",
        ...(analysis.committed === undefined ? {} : { committed: analysis.committed }),
        ...(analysis.noMutation === undefined ? {} : { noMutation: analysis.noMutation }),
        next: analysis.committed === undefined ? "" : "run `lando rebuild`",
      } satisfies AppConfigMigrateResult;
    }),
  );
