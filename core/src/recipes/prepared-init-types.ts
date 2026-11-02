import type {
  ConfigTranslateDiagnostic,
  LandofileAuthoringFragment,
  RecipeOptionValue,
} from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import type { CompiledRecipe, CompiledRecipeAction } from "./compiled-source.ts";

export interface RecipeInitPreparationRequest {
  readonly compiled: CompiledRecipe;
  readonly appRoot: string;
  readonly appName: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly secretAnswers?: Readonly<Record<string, string>>;
  readonly encoder: ConfigTranslatorShape;
}
export interface PreparedRecipeOutput {
  readonly destination: string;
  readonly content: Uint8Array;
  readonly mode: number;
  readonly digest: string;
}
export interface RecipeInitPreview {
  readonly landofile: string;
  readonly outputs: readonly {
    readonly destination: string;
    readonly mode: number;
    readonly digest: string;
    readonly bytes: number;
  }[];
  readonly actions: readonly {
    readonly index: number;
    readonly type: string;
    readonly authorized: boolean;
  }[];
  readonly conflicts: readonly string[];
  readonly skippedScaffold: readonly string[];
}
export interface PreparedRecipeInit {
  readonly status: "ready";
  readonly compiled: CompiledRecipe;
  readonly appRoot: string;
  readonly appName: string;
  readonly source: typeof LandofileAuthoringFragment.Type;
  readonly destinationAnchor: { readonly path: string; readonly dev: number; readonly ino: number };
  readonly answers: Readonly<Record<string, RecipeOptionValue>>;
  readonly secretAnswers?: Readonly<Record<string, string>>;
  readonly outputs: readonly PreparedRecipeOutput[];
  readonly actions: readonly CompiledRecipeAction[];
  readonly skippedScaffold: readonly string[];
  readonly conflicts: readonly string[];
  readonly diagnostics: readonly ConfigTranslateDiagnostic[];
  readonly preview: RecipeInitPreview;
  readonly redact: (text: string) => string;
}

export interface RecipeInitReview {
  readonly appName: string;
  readonly appRoot: string;
  readonly source: typeof LandofileAuthoringFragment.Type;
  readonly outputs: RecipeInitPreview["outputs"];
  readonly actions: RecipeInitPreview["actions"];
  readonly skippedScaffold: readonly string[];
  readonly diagnostics: readonly ConfigTranslateDiagnostic[];
}

/** Snapshot inert recipe data, including symbol-keyed literal/directive provenance and expression ASTs. */
export function snapshotRecipeInitData<T>(value: T): T;
export function snapshotRecipeInitData(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    Object.defineProperty(copy, key, {
      value: snapshotRecipeInitData(Reflect.get(value, key)),
      enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(copy);
}

export const recipeInitReview = (prepared: PreparedRecipeInit): RecipeInitReview =>
  snapshotRecipeInitData({
    appName: prepared.appName,
    appRoot: prepared.appRoot,
    source: prepared.source,
    outputs: prepared.preview.outputs,
    actions: prepared.preview.actions,
    skippedScaffold: prepared.skippedScaffold,
    diagnostics: prepared.diagnostics,
  });
