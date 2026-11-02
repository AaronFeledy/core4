import { Schema } from "effect";
import { ExpressionTemplate } from "../expressions/ast.ts";
import { LandofileSourceValue } from "./landofile-source.ts";
import { LandofileShape } from "./landofile.ts";
import { AbsolutePath } from "./primitives.ts";
import { ValidationIssuePath, ValidationIssueSource } from "./validation-issue.ts";

// =============================================================================
// Ephemeral compilation state, never part of an applied plan or cache record.
// =============================================================================
export const ParsedPendingSite = Schema.Struct({
  id: Schema.NonEmptyString.annotate({
    description: "Stable authored-site identity retained through composition.",
  }),
  path: ValidationIssuePath.annotate({ description: "Canonical destination path in the current document." }),
  source: ValidationIssueSource.annotate({
    description: "Original authored location, including original list index.",
  }),
  template: ExpressionTemplate.annotate({
    description: "Parsed-once expression template; produced strings are never reparsed.",
  }),
}).annotate({
  identifier: "ParsedPendingSite",
  description: "An unconsumed authored expression and its source attribution.",
});
export type ParsedPendingSite = typeof ParsedPendingSite.Type;

export const CompilationContext = Schema.Struct({
  appRoot: AbsolutePath.annotate({
    description: "Canonical application root captured for this compilation.",
  }),
  env: Schema.Record(Schema.String, Schema.String).annotate({
    description: "One captured host environment snapshot shared by all compilation stages.",
  }),
}).annotate({
  identifier: "CompilationContext",
  description: "Ephemeral compilation inputs, excluded from persisted plans.",
});
export type CompilationContext = typeof CompilationContext.Type;

const shared = {
  pendingSites: Schema.Array(ParsedPendingSite).annotate({
    description: "Surviving authored sites; consuming a site removes it.",
  }),
  context: CompilationContext.annotate({
    description: "Captured compilation inputs, not runtime lookup authority.",
  }),
};
const prepared = {
  ...shared,
  document: Schema.toType(LandofileShape).annotate({
    description: "Strictly decoded canonical Landofile document.",
  }),
};
const partial = {
  ...shared,
  document: LandofileSourceValue.annotate({
    description: "Partial authoring document before strict runtime decoding.",
  }),
};

export const SourceCompiledLandofile = Schema.Struct({
  ...partial,
  stage: Schema.Literal("source").annotate({ description: "Authored source stage." }),
}).annotate({
  identifier: "SourceCompiledLandofile",
  description: "Parsed source before authoring composition.",
});
export type SourceCompiledLandofile = typeof SourceCompiledLandofile.Type;
export const ComposedCompiledLandofile = Schema.Struct({
  ...partial,
  stage: Schema.Literal("composed").annotate({ description: "Composed authoring stage." }),
}).annotate({
  identifier: "ComposedCompiledLandofile",
  description: "Composed partial document before load-scope materialization.",
});
export type ComposedCompiledLandofile = typeof ComposedCompiledLandofile.Type;
export const LoadScopedLandofile = Schema.Struct({
  ...prepared,
  stage: Schema.Literal("load-scoped").annotate({ description: "Load scopes have been consumed." }),
}).annotate({
  identifier: "LoadScopedLandofile",
  description: "Strict document with load scopes consumed, ready for the planner.",
});
export type LoadScopedLandofile = typeof LoadScopedLandofile.Type;
export const IdentityScopedLandofile = Schema.Struct({
  ...prepared,
  stage: Schema.Literal("identity-scoped").annotate({
    description: "Application identity scopes have been consumed.",
  }),
}).annotate({
  identifier: "IdentityScopedLandofile",
  description: "Strict document with application identity scopes consumed.",
});
export type IdentityScopedLandofile = typeof IdentityScopedLandofile.Type;
export const ServiceScopedLandofile = Schema.Struct({
  ...prepared,
  stage: Schema.Literal("service-scoped").annotate({ description: "Service scopes have been consumed." }),
}).annotate({
  identifier: "ServiceScopedLandofile",
  description: "Strict document with service scopes consumed, ready for plan assembly.",
});
export type ServiceScopedLandofile = typeof ServiceScopedLandofile.Type;

export type CompiledLandofile =
  | SourceCompiledLandofile
  | ComposedCompiledLandofile
  | LoadScopedLandofile
  | IdentityScopedLandofile
  | ServiceScopedLandofile;
export const CompiledLandofile: Schema.Codec<
  CompiledLandofile,
  | typeof SourceCompiledLandofile.Encoded
  | typeof ComposedCompiledLandofile.Encoded
  | typeof LoadScopedLandofile.Encoded
  | typeof IdentityScopedLandofile.Encoded
  | typeof ServiceScopedLandofile.Encoded
> = Schema.Union([
  SourceCompiledLandofile,
  ComposedCompiledLandofile,
  LoadScopedLandofile,
  IdentityScopedLandofile,
  ServiceScopedLandofile,
]).annotate({
  identifier: "CompiledLandofile",
  description:
    "Explicit ephemeral compilation carrier with stage-specific documents and parsed pending sites.",
});
