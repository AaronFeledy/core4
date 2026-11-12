import type { SchemaAST } from "effect";

// Diagnostic-only metadata must not split shared nodes in generated authoring schemas.
export const executionSiteSources = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
