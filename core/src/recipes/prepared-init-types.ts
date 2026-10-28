import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
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
  readonly answers: Readonly<Record<string, unknown>>;
  readonly secretAnswers?: Readonly<Record<string, string>>;
  readonly outputs: readonly PreparedRecipeOutput[];
  readonly actions: readonly CompiledRecipeAction[];
  readonly skippedScaffold: readonly string[];
  readonly conflicts: readonly string[];
  readonly diagnostics: readonly ConfigTranslateDiagnostic[];
  readonly preview: RecipeInitPreview;
  readonly redact: (text: string) => string;
}
