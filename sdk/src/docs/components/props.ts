import { Either, type ParseResult, Schema } from "effect";

import { NotImplementedError } from "../../errors/index.ts";
import { GuideId } from "../guide-frontmatter.ts";

const ComponentId = GuideId.annotations({ identifier: "ComponentId" });

const betaRemediation = (surface: string, specSection = "§19.3") =>
  `${surface} ships in Phase 3 Beta per ${specSection} — see \`spec/ROADMAP.md\`.`;

const betaComponentPropsError = (
  component: string,
  key: string,
  specSection = "§19.3",
): NotImplementedError =>
  new NotImplementedError({
    message: `<${component}> prop \`${key}\` is not supported in Alpha 2.`,
    commandId: `guide.component.${component.toLowerCase()}`,
    specSection,
    remediation: betaRemediation(`<${component}> \`${key}\``, specSection),
  });

const hiddenComponentError = (): NotImplementedError =>
  new NotImplementedError({
    message: "<Hidden> is recognized but not generated in Alpha 2.",
    commandId: "guide.component.hidden",
    specSection: "§19.3",
    remediation:
      "Move this coverage into a colocated `<Scenario render={false}>` per §19.9. `<Hidden>` ships in Phase 3 Beta — see `spec/ROADMAP.md`.",
  });

const ALPHA_2_COMPONENTS = [
  "Guide",
  "Scenario",
  "Step",
  "Run",
  "Verify",
  "Cleanup",
  "Variable",
  "UseFixture",
] as const;

const betaComponentError = (componentName: string, hostPath: string): NotImplementedError =>
  new NotImplementedError({
    message: `<${componentName}> is not supported in Alpha 2 at ${hostPath}.`,
    commandId: `guide.component.${componentName.toLowerCase()}`,
    specSection: "§19.3",
    remediation: `<${componentName}> ships in Phase 3 Beta — see \`spec/ROADMAP.md\`.`,
  });

export const assertAlpha2Component = (componentName: string, hostPath: string): void => {
  if (componentName === "Hidden") throw hiddenComponentError();
  if (ALPHA_2_COMPONENTS.some((name) => name === componentName)) return;
  throw betaComponentError(componentName, hostPath);
};

const asRecord = (input: unknown): Record<string, unknown> | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
};

export const MatcherScalar = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
).annotations({
  identifier: "MatcherScalar",
});
export type MatcherScalar = typeof MatcherScalar.Type;

export const MatcherRegex = Schema.Struct({ regex: Schema.String }).annotations({
  identifier: "MatcherRegex",
});
export type MatcherRegex = typeof MatcherRegex.Type;

export const MatcherSchemaRef = Schema.Struct({ schema: Schema.String }).annotations({
  identifier: "MatcherSchemaRef",
});
export type MatcherSchemaRef = typeof MatcherSchemaRef.Type;

export const MatcherAnyOf = Schema.Struct({ anyOf: Schema.Array(Schema.Unknown) }).annotations({
  identifier: "MatcherAnyOf",
});
export type MatcherAnyOf = typeof MatcherAnyOf.Type;

export const MatcherNot = Schema.Struct({ not: Schema.Unknown }).annotations({ identifier: "MatcherNot" });
export type MatcherNot = typeof MatcherNot.Type;

const MATCHER_OPERATOR_KEYS = ["regex", "schema", "anyOf", "not", "exact", "allOf", "oneOf"] as const;

export const MatcherPartialObject = Schema.Record({ key: Schema.String, value: Schema.Unknown })
  .pipe(
    Schema.filter((input) => MATCHER_OPERATOR_KEYS.every((key) => !Object.hasOwn(input, key)), {
      message: () => "Matcher partial objects cannot use reserved matcher operator keys.",
      jsonSchema: {},
    }),
  )
  .annotations({
    identifier: "MatcherPartialObject",
  });
export type MatcherPartialObject = typeof MatcherPartialObject.Type;

export const MatcherSchema = Schema.Union(
  MatcherScalar,
  Schema.Array(Schema.Unknown),
  MatcherRegex,
  MatcherSchemaRef,
  MatcherAnyOf,
  MatcherNot,
  MatcherPartialObject,
).annotations({
  identifier: "MatcherSchema",
  title: "Matcher Schema",
  description: "Alpha 2 declarative matcher subset for executable-guide verification.",
});
export type MatcherSchema = typeof MatcherSchema.Type;

export const GuideProps = Schema.Struct({}).annotations({
  identifier: "GuideProps",
  title: "Guide Props",
  description: "Alpha 2 <Guide> component props.",
});
export type GuideProps = typeof GuideProps.Type;

export const ScenarioProps = Schema.Struct({
  id: ComponentId,
  render: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  reason: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  layer: Schema.optional(Schema.Literal("scenario")),
})
  .pipe(
    Schema.filter(
      (input) => input.render !== false || (input.reason !== undefined && input.reason.length >= 8),
      {
        message: () => "<Scenario render={false}> requires a `reason` of at least 8 characters.",
        jsonSchema: {},
      },
    ),
  )
  .annotations({
    identifier: "ScenarioProps",
    title: "Scenario Props",
    description: "Alpha 2 <Scenario> component props.",
  });
export type ScenarioProps = typeof ScenarioProps.Type;

export const StepProps = Schema.Struct({
  name: ComponentId,
}).annotations({
  identifier: "StepProps",
  title: "Step Props",
  description: "Alpha 2 <Step> component props.",
});
export type StepProps = typeof StepProps.Type;

export const RunProps = Schema.Struct({
  command: Schema.optional(Schema.String),
  shell: Schema.optional(Schema.String),
  answers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  expectExit: Schema.optional(Schema.Number.pipe(Schema.int())),
})
  .pipe(
    Schema.filter(
      (input) => [input.command, input.shell].filter((value) => value !== undefined).length === 1,
      {
        message: () => "<Run> requires exactly one of `command` or `shell`.",
        jsonSchema: {},
      },
    ),
  )
  .annotations({
    identifier: "RunProps",
    title: "Run Props",
    description: "Alpha 2 <Run> component props.",
  });
export type RunProps = typeof RunProps.Type;

export const VerifyProps = Schema.Struct({
  event: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  errorTag: Schema.optional(Schema.String),
  expect: Schema.optional(MatcherSchema),
})
  .pipe(
    Schema.filter(
      (input) =>
        [input.event, input.command, input.file, input.errorTag].filter((value) => value !== undefined)
          .length === 1,
      { message: () => "<Verify> requires exactly one target.", jsonSchema: {} },
    ),
  )
  .annotations({
    identifier: "VerifyProps",
    title: "Verify Props",
    description: "Alpha 2 <Verify> component props.",
  });
export type VerifyProps = typeof VerifyProps.Type;

export const CleanupProps = Schema.Struct({}).annotations({
  identifier: "CleanupProps",
  title: "Cleanup Props",
  description: "Alpha 2 <Cleanup> component props.",
});
export type CleanupProps = typeof CleanupProps.Type;

export const VariableProps = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  display: Schema.optional(Schema.String),
}).annotations({
  identifier: "VariableProps",
  title: "Variable Props",
  description: "Alpha 2 <Variable> component props.",
});
export type VariableProps = typeof VariableProps.Type;

export const HiddenProps = Schema.Struct({
  reason: Schema.String.pipe(Schema.minLength(8)),
}).annotations({
  identifier: "HiddenProps",
  title: "Hidden Props",
  description: "Alpha 2 <Hidden> component props.",
});
export type HiddenProps = typeof HiddenProps.Type;

export const UseFixtureProps = Schema.Struct({
  name: Schema.String,
}).annotations({
  identifier: "UseFixtureProps",
  title: "Use Fixture Props",
  description: "Alpha 2 <UseFixture> component props.",
});
export type UseFixtureProps = typeof UseFixtureProps.Type;

type DecodeError = NotImplementedError | ParseResult.ParseError;

const decodeEither = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Either.Either<A, DecodeError> =>
  Schema.decodeUnknownEither(schema)(input, { onExcessProperty: "error" });

export const decodeScenarioPropsEither = (input: unknown): Either.Either<ScenarioProps, DecodeError> => {
  const record = asRecord(input);
  if (record?.layer === "e2e") return Either.left(betaComponentPropsError("Scenario", "layer", "§19.11"));
  return decodeEither(ScenarioProps, input);
};

export const decodeStepPropsEither = (input: unknown): Either.Either<StepProps, DecodeError> =>
  decodeEither(StepProps, input);

export const decodeRunPropsEither = (input: unknown): Either.Either<RunProps, DecodeError> => {
  const record = asRecord(input);
  if (record !== undefined) {
    if (Object.hasOwn(record, "runtime"))
      return Either.left(betaComponentPropsError("Run", "runtime", "§19.14"));
    if (Object.hasOwn(record, "tooling"))
      return Either.left(betaComponentPropsError("Run", "tooling", "§19.14"));
  }
  return decodeEither(RunProps, input);
};

const findBetaMatcherKey = (input: unknown): "exact" | "allOf" | "oneOf" | undefined => {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findBetaMatcherKey(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(input);
  if (record === undefined) return undefined;
  for (const key of ["exact", "allOf", "oneOf"] as const) {
    if (Object.hasOwn(record, key)) return key;
  }
  for (const value of Object.values(record)) {
    const found = findBetaMatcherKey(value);
    if (found !== undefined) return found;
  }
  return undefined;
};

export const decodeVerifyPropsEither = (input: unknown): Either.Either<VerifyProps, DecodeError> => {
  const record = asRecord(input);
  if (record !== undefined) {
    if (Object.hasOwn(record, "runtime"))
      return Either.left(betaComponentPropsError("Verify", "runtime", "§19.14"));
    if (Object.hasOwn(record, "tooling"))
      return Either.left(betaComponentPropsError("Verify", "tooling", "§19.14"));
    const betaMatcherKey = findBetaMatcherKey(record.expect);
    if (betaMatcherKey !== undefined)
      return Either.left(betaComponentPropsError("Verify", betaMatcherKey, "§19.3"));
  }
  return decodeEither(VerifyProps, input);
};

export const decodeCleanupPropsEither = (input: unknown): Either.Either<CleanupProps, DecodeError> =>
  decodeEither(CleanupProps, input);

export const decodeVariablePropsEither = (input: unknown): Either.Either<VariableProps, DecodeError> =>
  decodeEither(VariableProps, input);

export const decodeUseFixturePropsEither = (input: unknown): Either.Either<UseFixtureProps, DecodeError> =>
  decodeEither(UseFixtureProps, input);

export const hiddenComponentNotImplemented = hiddenComponentError;
