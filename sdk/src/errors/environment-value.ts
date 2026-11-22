import { Schema } from "effect";

export class RouteUrlBindingError extends Schema.TaggedError<RouteUrlBindingError>()(
  "RouteUrlBindingError",
  {
    _tag: Schema.tag("RouteUrlBindingError").annotate({
      description: "Public URL binding failure discriminator.",
    }),
    reason: Schema.Literals([
      "no-route",
      "router-unsupported",
      "authority-changed",
      "retained-consumer",
    ]).annotate({ description: "Why the public service URL could not be bound." }),
    service: Schema.String.annotate({ description: "Name of the service whose URL is referenced." }),
    consumers: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: "Services reading this URL.",
    }),
    message: Schema.String.annotate({ description: "Public URL binding failure explanation." }),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).annotate({
      description: "How to resolve the public URL binding failure.",
    }),
  },
  { description: "A service's public route URL could not be bound safely during activation." },
) {}

export class EnvironmentValueResolutionError extends Schema.TaggedError<EnvironmentValueResolutionError>()(
  "EnvironmentValueResolutionError",
  {
    _tag: Schema.tag("EnvironmentValueResolutionError").annotate({
      description: "Environment resolution failure discriminator.",
    }),
    message: Schema.String.annotate({
      description: "Safe failure explanation, containing no resolved values.",
    }),
    variable: Schema.optionalKey(Schema.String).annotate({
      description: "Environment variable requiring resolution.",
    }),
    reference: Schema.optionalKey(Schema.String).annotate({
      description: "Failing reference identifier, never its value.",
    }),
    reason: Schema.Literals(["unresolved-binding", "invalid-value", "budget-exceeded"]).annotate({
      description: "Resolution failure classification.",
    }),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).annotate({
      description: "Action needed to resolve the environment safely.",
    }),
  },
  { description: "Environment descriptor resolution failed before dispatch." },
) {}

export class PlanReplanRequiredError extends Schema.TaggedError<PlanReplanRequiredError>()(
  "PlanReplanRequiredError",
  {
    _tag: Schema.tag("PlanReplanRequiredError").annotate({
      description: "Historical plan creation rejection discriminator.",
    }),
    providerId: Schema.String.annotate({ description: "Provider asked to create or recreate services." }),
    cause: Schema.optional(Schema.Unknown).annotate({
      description: "Failure preventing applied-plan verification.",
    }),
    operation: Schema.String.annotate({
      description: "Creation operation rejected by the eligibility gate.",
    }),
    message: Schema.String.annotate({ description: "Safe explanation of missing execution eligibility." }),
    app: Schema.String.annotate({ description: "Application whose plan must be regenerated." }),
    valueModel: Schema.optionalKey(Schema.Literal(1)).annotate({
      description: "Observed value model marker, absent on historical plans.",
    }),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).annotate({
      description: "Replan command or instructions required before creation.",
    }),
  },
  { description: "An observed historical plan cannot authorize service creation." },
) {}
