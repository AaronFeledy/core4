import { Schema, type SchemaAST } from "effect";
import { executionSiteSources } from "./execution-site-source.ts";

// ============================================================================
// Authored execution semantics, private annotations with public inspection.
// ============================================================================

export const SchemaExecutionSiteAnnotationId = "lando/schema/ExecutionSite" as const;

export const ExecutionSite = Schema.Literals([
  "service-command",
  "service-entrypoint",
  "healthcheck",
  "build-app",
  "build-artifact",
  "build-arg",
  "build-dockerfile",
  "tooling-task",
  "tooling-cmd",
  "tooling-cmds",
  "tooling-var",
  "event-step",
  "event-lando-command",
]).annotate({
  identifier: "ExecutionSite",
  title: "Execution Site",
  description: "Authored command execution semantics for a Landofile string.",
});
export type ExecutionSite = typeof ExecutionSite.Type;

export const executionSite = <S extends Schema.Top>(schema: S, site: ExecutionSite) => {
  const annotated = schema.annotate({ [SchemaExecutionSiteAnnotationId]: site });
  executionSiteSources.set(annotated.ast, schema.ast);
  return annotated;
};

export const executionSiteKey = <S extends Schema.Top>(schema: S, site: ExecutionSite): S["Rebuild"] => {
  const annotated = schema.annotateKey({ [SchemaExecutionSiteAnnotationId]: site });
  executionSiteSources.set(annotated.ast, schema.ast);
  return annotated;
};

export const getExecutionSite = (ast: SchemaAST.AST): ExecutionSite | undefined => {
  const value =
    ast.annotations?.[SchemaExecutionSiteAnnotationId] ??
    ast.context?.annotations?.[SchemaExecutionSiteAnnotationId];
  return Schema.is(ExecutionSite)(value) ? value : undefined;
};
