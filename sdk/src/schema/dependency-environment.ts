import { Schema } from "effect";

const EnvironmentKind = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/));
const ContainerPath = Schema.String.check(Schema.isPattern(/^\/(?:[^/\0]+\/)*[^/\0]+$/));

export const DependencyEnvironmentIntent = Schema.Struct({
  kind: EnvironmentKind.annotate({ description: "Short id for the dependency environment kind." }),
  target: ContainerPath.annotate({ description: "Canonical absolute container path below the app mount." }),
  identity: Schema.Record(Schema.String, Schema.String).annotate({
    description: "Toolchain facts that define which dependency trees are interchangeable.",
  }),
  prepare: Schema.NonEmptyArray(Schema.String).annotate({
    description: "Prepare command argv, with the environment owner's principal appended by the planner.",
  }),
  activation: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Default environment variables for eligible consumers.",
  }),
  cache: Schema.optionalKey(
    Schema.Struct({
      name: EnvironmentKind,
      target: ContainerPath,
      variable: Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/)),
    }),
  ).annotate({ description: "Optional global cache and its configuration variable for the prepare job." }),
  inputs: Schema.optionalKey(Schema.String).annotate({
    description: "Project input files to name in failure remediation.",
  }),
});

export type DependencyEnvironmentIntent = typeof DependencyEnvironmentIntent.Type;

export const DEPENDENCY_ENVIRONMENT_EXTENSION_KEY = "@lando/core/dependency-environment";

export const DependencyEnvironmentJob = Schema.Struct({
  kind: EnvironmentKind,
  consumers: Schema.NonEmptyArray(Schema.String),
  inputs: Schema.optionalKey(Schema.String),
});
