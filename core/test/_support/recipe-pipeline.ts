import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { Effect } from "effect";
import {
  type RecipeInitPipelineRequest,
  runRecipeInitPipeline as runPipeline,
} from "../../src/recipes/init-pipeline.ts";
import type { RecipeInitReview } from "../../src/recipes/prepared-init-types.ts";

export const runRecipeInitPipeline = <E = never, R = never>(
  request: RecipeInitPipelineRequest,
  onPrepared?: (review: RecipeInitReview) => Effect.Effect<void, E, R>,
) => runPipeline(request, onPrepared).pipe(Effect.provide(BunProcessRunner.layer));
