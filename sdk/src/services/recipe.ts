import { Context, type Effect } from "effect";

import type {
  NotImplementedError,
  RecipeManifestNotFoundError,
  RecipeManifestParseError,
  RecipeManifestValidationError,
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
      | RecipeManifestNotFoundError
      | RecipeManifestParseError
      | RecipeManifestValidationError
      | NotImplementedError
    >;
  }
>() {}
