import { LandoRuntimeOptions } from "@lando/engine/runtime/runtime-options";
import { DeliverableEventSchema } from "@lando/engine/services/event-validation";
import { CliCommandInitEvent, CliCommandRunEvent } from "@lando/sdk/events";
import { AppPlan, BunShellScriptFrontMatter, GlobalConfig, LandofileShape } from "@lando/sdk/schema";
import type { SchemaAST } from "effect";

/**
 * Schemas whose decoders are compiled ahead of time into
 * `generated/compiled-decoders.mjs`. The generated `install` trusts this exact
 * order and these exact AST instances, so regenerate after any change here, to
 * a listed schema, or to the Effect version.
 */
export const COMPILED_DECODER_ASTS: ReadonlyArray<SchemaAST.AST> = [
  GlobalConfig.ast,
  LandoRuntimeOptions.ast,
  BunShellScriptFrontMatter.ast,
  CliCommandInitEvent.ast,
  CliCommandRunEvent.ast,
  DeliverableEventSchema.ast,
  LandofileShape.ast,
  AppPlan.ast,
];
