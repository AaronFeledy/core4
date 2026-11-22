import { Schema } from "effect";

// ============================================================================
// Service-type launcher markers and the table of argv prefixes they expand to.
// ============================================================================

/**
 * Colon-prefixed kebab-case launcher marker grammar. `:host` matches the
 * pattern but is reserved and excluded from {@link ServiceLaunchers} keys.
 */
const SERVICE_LAUNCHER_MARKER_PATTERN = /^:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export const ServiceLauncherMarker = Schema.String.check(
  Schema.isPattern(SERVICE_LAUNCHER_MARKER_PATTERN, {
    message:
      "Expected a launcher marker such as :local-bin: a colon, a lowercase letter, then lowercase letters, digits, or hyphen-separated segments.",
  }),
).annotate({
  identifier: "ServiceLauncherMarker",
  title: "Service Launcher Marker",
  description:
    "Colon-prefixed kebab-case launcher marker such as :local-bin or :node-install-run. Starts with a lowercase letter after the colon; further segments are lowercase alphanumerics separated by single hyphens.",
});
export type ServiceLauncherMarker = typeof ServiceLauncherMarker.Type;

const isServiceLauncherMarker = Schema.is(ServiceLauncherMarker);

const launcherArgvPrefix = Schema.NonEmptyArray(Schema.String).check(
  Schema.makeFilter((argv) => argv[0].length > 0, {
    message: "Launcher argv prefix must start with a non-empty program name.",
    toJsonSchema: () => ({
      prefixItems: [{ type: "string", minLength: 1 }],
      items: { type: "string" },
      minItems: 1,
    }),
  }),
);

/**
 * Service-type map from launcher marker to a non-empty argv prefix. Keys must
 * match {@link ServiceLauncherMarker} and must not be the reserved `:host`
 * execution site. Values are the argv fragments the planner substitutes for a
 * leading marker on tooling `cmd` or service `command`.
 */
export const ServiceLaunchers = Schema.Record(Schema.String, launcherArgvPrefix)
  .check(
    Schema.makeFilter(
      (table) => Object.keys(table).every((name) => name !== ":host" && isServiceLauncherMarker(name)),
      {
        message:
          'Launcher table keys must be markers such as :local-bin and must not use the reserved ":host" site.',
        toJsonSchema: () => ({
          propertyNames: {
            pattern: SERVICE_LAUNCHER_MARKER_PATTERN.source,
            not: { const: ":host" },
          },
        }),
      },
    ),
  )
  .annotate({
    identifier: "ServiceLaunchers",
    title: "Service Launchers",
    description:
      "Service-type table from a launcher marker to a non-empty argv prefix. Keys match the marker grammar and exclude the reserved :host site; each value is a non-empty argv array whose first element is a non-empty program name.",
  });
export type ServiceLaunchers = typeof ServiceLaunchers.Type;
