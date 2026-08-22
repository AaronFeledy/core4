import { Context, type Effect } from "effect";

import type {
  NotImplementedError,
  RecipeExtendsError,
  RecipeManifestNotFoundError,
  RecipeManifestParseError,
  RecipeManifestValidationError,
  RecipeSourceError,
} from "../errors/index.ts";
import type { RecipeManifest } from "../schema/index.ts";

export class RecipeManifestService extends Context.Tag("@lando/core/RecipeManifestService")<
  RecipeManifestService,
  {
    readonly parse: (
      source: string,
      content: string,
    ) => Effect.Effect<
      RecipeManifest,
      | RecipeExtendsError
      | RecipeManifestNotFoundError
      | RecipeManifestParseError
      | RecipeManifestValidationError
      | RecipeSourceError
      | NotImplementedError
    >;
  }
>() {}
