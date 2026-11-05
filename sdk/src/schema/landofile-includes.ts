import { Schema } from "effect";
import { ToolingVarLiteral } from "./primitives.ts";

const IncludeWhen = Schema.Union([Schema.Boolean, Schema.String]).annotate({
  description:
    "Boolean or whole-value {{ ... }} expression over recipe and env that must resolve to a boolean. False skips the include before acquisition; includes update and verify ignore this condition.",
});

export const ToolingIncludeShape = Schema.Struct({
  file: Schema.String.annotate({
    description:
      "Path to the tooling fragment, resolved relative to the file that declares the include and contained under the app root.",
  }),
  when: Schema.optionalKey(IncludeWhen),
  optional: Schema.optionalKey(Schema.Boolean).annotate({
    description: "When true, a missing fragment file is skipped instead of failing the load.",
  }),
  flatten: Schema.optionalKey(Schema.Boolean).annotate({
    description: "When true, included task names register unprefixed instead of under the include namespace.",
  }),
  internal: Schema.optionalKey(Schema.Boolean).annotate({
    description: "When true, every task contributed by this include is registered hidden.",
  }),
  aliases: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Additional namespaces the included tasks also register under.",
  }),
  excludes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Fragment task names dropped before flattening or namespace registration.",
  }),
  vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)).annotate({
    description: "Literal vars applied to every included task unless the task defines its own value.",
  }),
});
export type ToolingIncludeShape = typeof ToolingIncludeShape.Type;

export const IncludeEntry = Schema.Union([
  Schema.String,
  Schema.Struct({
    source: Schema.String,
    when: Schema.optionalKey(IncludeWhen),
    kind: Schema.optionalKey(Schema.Literals(["landofile", "compose", "tooling"])).annotate({
      description:
        'The fragment content semantics: "landofile" is a Landofile fragment; "compose" is a Compose fragment routed through the same parser, rejection, and decode path; "tooling" is a tooling fragment carrying only tooling: and toolingIncludes:. This is not source transport.',
    }),
    path: Schema.optionalKey(Schema.String),
    version: Schema.optionalKey(Schema.String),
    namespace: Schema.optionalKey(Schema.String).annotate({
      description:
        'kind: "tooling" only: the sub-namespace included tasks register under. Required unless flatten is true.',
    }),
    flatten: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        'kind: "tooling" only: when true, included task names register unprefixed instead of under the include namespace.',
    }),
    internal: Schema.optionalKey(Schema.Boolean).annotate({
      description: 'kind: "tooling" only: when true, every task contributed by this include is hidden.',
    }),
    optional: Schema.optionalKey(Schema.Boolean).annotate({
      description: 'kind: "tooling" only: when true, a missing fragment file is skipped instead of failing.',
    }),
    aliases: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: 'kind: "tooling" only: additional namespaces the included tasks also register under.',
    }),
    excludes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        'kind: "tooling" only: fragment task names dropped before flattening or namespace registration.',
    }),
    vars: Schema.optionalKey(Schema.Record(Schema.String, ToolingVarLiteral)).annotate({
      description:
        'kind: "tooling" only: literal vars applied to every included task unless the task defines its own value.',
    }),
  }),
]);
export type IncludeEntry = typeof IncludeEntry.Type;
