import { Schema } from "effect";

import { BootstrapLevel } from "../schema/primitives.ts";
import { ValidationIssue } from "../schema/validation-issue.ts";

export class PluginLoadError extends Schema.TaggedError<PluginLoadError>()("PluginLoadError", {
  message: Schema.String,
  pluginName: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

export class PluginManifestError extends Schema.TaggedError<PluginManifestError>()("PluginManifestError", {
  message: Schema.String,
  pluginName: Schema.optional(Schema.String),
  issues: Schema.Array(ValidationIssue),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

export class SubscriberLevelMismatchError extends Schema.TaggedError<SubscriberLevelMismatchError>()(
  "SubscriberLevelMismatchError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    pluginName: Schema.String,
    subscriberId: Schema.String,
    selectedEvent: Schema.String,
    declaredLevel: BootstrapLevel,
    eventLevel: Schema.Literals(["minimal", "plugins", "commands", "tooling", "provider", "app"]),
  },
) {}

export class PluginDescriptorMismatchError extends Schema.TaggedError<PluginDescriptorMismatchError>()(
  "PluginDescriptorMismatchError",
  {
    pluginName: Schema.String,
    kind: Schema.String,
    declared: Schema.Array(Schema.String),
    provided: Schema.Array(Schema.String),
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export const CertificateAuthorityCandidate = Schema.Struct({
  id: Schema.String,
  pluginName: Schema.String,
  source: Schema.String,
});

export class NoCertificateAuthorityError extends Schema.TaggedError<NoCertificateAuthorityError>()(
  "NoCertificateAuthorityError",
  {
    message: Schema.String,
    candidates: Schema.Array(CertificateAuthorityCandidate),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class AmbiguousCertificateAuthoritiesError extends Schema.TaggedError<AmbiguousCertificateAuthoritiesError>()(
  "AmbiguousCertificateAuthoritiesError",
  {
    message: Schema.String,
    candidates: Schema.Array(CertificateAuthorityCandidate),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
