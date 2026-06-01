import { Schema } from "effect";

import { ArtifactBuildSpec, ArtifactRef } from "./artifacts.ts";
import { AppId, CommandSpec, PlanMetadata, ServiceName } from "./primitives.ts";

// BuildPlan — DAG over BuildSteps for artifact and app work.

export const BuildPhase = Schema.Literal("artifact", "app");
export type BuildPhase = typeof BuildPhase.Type;

export const BuildStep = Schema.Struct({
  /** Stable id within the BuildPlan (`<service>:<phase>:<seq>`). */
  id: Schema.String,
  /** Service this step builds for. */
  service: ServiceName,
  /** Which phase this step belongs to. */
  phase: BuildPhase,
  /** Operation kind: pull/build artifact, or run a build script. */
  kind: Schema.Literal("buildArtifact", "pullArtifact", "execStream"),
  /** Build script (kind = execStream) — argv form. */
  command: Schema.optional(CommandSpec),
  /** Artifact spec (kind = buildArtifact / pullArtifact). */
  artifact: Schema.optional(Schema.Union(ArtifactRef, ArtifactBuildSpec)),
  /** Step ids this step depends on. */
  dependsOn: Schema.Array(Schema.String),
  /** Content-hash key for the up-to-date check. */
  buildKey: Schema.String,
});
export type BuildStep = typeof BuildStep.Type;

export const BuildPlan = Schema.Struct({
  /** App this BuildPlan belongs to. */
  appId: AppId,
  /** Total step count (artifact + app). */
  totalSteps: Schema.Number,
  /** All steps, topologically orderable via `dependsOn`. */
  steps: Schema.Array(BuildStep),
  metadata: PlanMetadata,
});
export type BuildPlan = typeof BuildPlan.Type;
