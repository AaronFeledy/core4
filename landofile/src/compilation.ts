import { encodeLandofileSourceValue } from "@lando/sdk/landofile";
import {
  AbsolutePath,
  type CompilationContext,
  ComposedCompiledLandofile,
  LandofileSourceValue,
  type ParsedPendingSite,
  SourceCompiledLandofile,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import type { LandofileProvenance } from "./provenance.ts";
import { hostExpressionEnvironment } from "./recipe-expressions.ts";

/**
 * Capture compilation inputs. `env` must be the raw captured snapshot (string
 * values only), never the dependency-recording view from `recordEnvironment`.
 */
export const captureCompilationContext = (
  appRoot: string,
  env: Readonly<Record<string, string>> = hostExpressionEnvironment(),
): CompilationContext => ({ appRoot: AbsolutePath.make(appRoot), env: { ...env } });

export const sourceCarrier = (input: {
  readonly document: unknown;
  readonly provenance: LandofileProvenance;
  readonly pendingSites: readonly ParsedPendingSite[];
  readonly context: CompilationContext;
}) =>
  SourceCompiledLandofile.make({
    ...input,
    document: Schema.decodeUnknownSync(LandofileSourceValue)(encodeLandofileSourceValue(input.document)),
    stage: "source",
  });

export const composedCarrier = (input: {
  readonly document: Record<string, unknown>;
  readonly provenance: LandofileProvenance;
  readonly pendingSites: readonly ParsedPendingSite[];
  readonly context: CompilationContext;
}) =>
  ComposedCompiledLandofile.make({
    ...input,
    document: Schema.decodeUnknownSync(LandofileSourceValue)(encodeLandofileSourceValue(input.document)),
    stage: "composed",
  });
