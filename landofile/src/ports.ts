import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { TemplateRenderContext } from "@lando/sdk/schema";
import type { ManagedFileTransactionGuard, StateStoreShape } from "@lando/sdk/services";
import type { SourceTransports } from "@lando/source-acquisition";
import type { Context } from "effect";

/**
 * Runtime ports for Landofile resolution. Remote acquisition goes through
 * `sources` (injected transports); landofile builds a SourceStore per walk.
 */
export interface LandofileRuntimePorts {
  readonly resolveUserCacheRoot: () => string;
  readonly resolveUserIncludesDir: () => string;
  /** Base transports for makeSourceStore; test deps may override individual members. */
  readonly sources: SourceTransports;
}

export interface TemplateEngineInputs {
  readonly modules: ReadonlyArray<LandoPluginModule>;
  readonly context?: TemplateRenderContext;
}

export interface LandofileRuntimeInputs {
  /** Read cached include snapshots without acquiring or publishing new sources or lock pins. */
  readonly readOnly?: boolean;
  readonly transactionGuard?: Context.Service.Shape<typeof ManagedFileTransactionGuard>;
  readonly stateStore?: StateStoreShape;
  readonly ports: LandofileRuntimePorts;
  readonly templates: TemplateEngineInputs;
}

export type LandofileEvaluationInputs = Pick<LandofileRuntimeInputs, "ports" | "templates" | "stateStore">;
