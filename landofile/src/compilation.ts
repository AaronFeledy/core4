import { encodeLandofileSourceValue, isPlainRecord } from "@lando/sdk/landofile";
import {
  AbsolutePath,
  type CompilationContext,
  ComposedCompiledLandofile,
  LandofileSourceValue,
  type ParsedPendingSite,
  SourceCompiledLandofile,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import { hostExpressionEnvironment } from "./recipe-expressions.ts";

export const captureCompilationContext = (
  appRoot: string,
  env: Readonly<Record<string, string>> = hostExpressionEnvironment(),
): CompilationContext => ({ appRoot: AbsolutePath.make(appRoot), env: { ...env } });

export const sourceCarrier = (input: {
  readonly document: unknown;
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
  readonly pendingSites: readonly ParsedPendingSite[];
  readonly context: CompilationContext;
}) => {
  const compiled = ComposedCompiledLandofile.make({
    ...input,
    document: Schema.decodeUnknownSync(LandofileSourceValue)(encodeLandofileSourceValue(input.document)),
    stage: "composed",
  });
  if (isPlainRecord(compiled.document)) copyLandofileProvenance(input.document, compiled.document);
  return compiled;
};
