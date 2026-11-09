import { Record, Schema } from "effect";

// ============================================================================
// Registered config diagnostic metadata
// ============================================================================

export const ConfigLintRuleDescriptor = Schema.Struct({
  stages: Schema.NonEmptyArray(
    Schema.Literals([
      "fragment",
      "load",
      "effective",
      "resolve",
      "planning",
      "global-config",
      "discovery",
      "script",
    ]),
  ).annotate({ description: "Validation stages that can report this rule." }),
  severities: Schema.NonEmptyArray(Schema.Literals(["error", "warning"])).annotate({
    description: "Severities emitted by this rule's producers.",
  }),
  summary: Schema.String.annotate({ description: "What the rule checks." }),
  examplePaths: Schema.NonEmptyArray(Schema.String).annotate({
    description: "Representative paths, written the way `lando app:config:lint` prints them.",
  }),
}).annotate({
  identifier: "ConfigLintRuleDescriptor",
  title: "Config lint rule descriptor",
  description: "Stages, severities, purpose, and representative paths of a registered config diagnostic.",
});
export type ConfigLintRuleDescriptor = typeof ConfigLintRuleDescriptor.Type;

export const CONFIG_LINT_RULES = {
  "script.front-matter": {
    stages: ["script"],
    severities: ["error"],
    summary:
      "Script read failures, empty files, missing or invalid front matter, unsupported metadata or service targets, conflicting inputs, and duplicate canonical ids.",
    examplePaths: [".lando/scripts/deploy.bun.sh", ".lando/scripts/deploy.bun.sh:flags.verbose"],
  },
  "script.host-shell": {
    stages: ["script"],
    severities: ["error"],
    summary:
      "An enabled, unshadowed .bun.sh script uses a form Bun Shell cannot run. The finding carries its physical line and column and the supported replacement.",
    examplePaths: [".lando/scripts/deploy.bun.sh"],
  },
  "landofile.validation": {
    stages: ["fragment", "effective", "planning"],
    severities: ["error"],
    summary:
      "Unknown keys, wrong literal types, and missing required fields in authored files, effective configuration, or the final plan; unsupported planning operations.",
    examplePaths: ["services.web.imgae"],
  },
  "landofile.compose-rejection": {
    stages: ["fragment"],
    severities: ["error"],
    summary: "Compose keys Lando rejects, including network attachment fields other than `aliases`.",
    examplePaths: ["services.web.deploy.replicas", "services.web.networks.backend.ipv4_address"],
  },
  "landofile.load": {
    stages: ["load"],
    severities: ["error"],
    summary:
      "Layer parse errors, failed load or recipe and env expressions, `${secret:...}` references outside a binding site, invalid include conditions, include and tooling include failures, lock mismatches, and invalid `lando:` ranges. `reason` names the cause: a nested rule such as `unsupported-expression`, or the load failure's tag.",
    examplePaths: ["includes[1].when", "toolingIncludes.docs", "lando"],
  },
  "landofile.expression": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary: "`{{ }}` sites that cannot be resolved, or whose value has the wrong type after evaluation.",
    examplePaths: ["tooling.t.cmd"],
  },
  "landofile.service": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "Service-type configuration: native port variables, reserved ports, unsupported versions, storage scopes, duplicate log source ids, `appMount`, `webroot` on a type without support, and endpoint declarations.",
    examplePaths: ["services.db.environment.PGPORT", "services.web.endpoints"],
  },
  "landofile.hostname": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "Each `hostnames:` entry is a plain DNS name, and each `extra_hosts` host name is a host-alias name of letters, digits, hyphens, and underscores, after evaluation.",
    examplePaths: ["services.web.hostnames[0]", "services.web.extra_hosts.my_db"],
  },
  "landofile.dns-name": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "No two services claim the same name on one network, ignoring case; no two services would share a container name; and no authored name takes Lando's container-name shape `lando-<app>--<service>`.",
    examplePaths: ["services.api.hostnames[0]"],
  },
  "landofile.route": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "Route syntax, final generated hostnames, authored HTTP endpoint selection, app and host router provider alignment, and HTTPS routes with a wildcard below the leftmost label, which no certificate can cover.",
    examplePaths: ["services.web.routes[1]", "services.web.routes[0].hostname", "proxy.web[0]"],
  },
  "landofile.network": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "Service `networks:` keys are declared at the top level, no `networks.default`, `name` only with `external: true`, no `driver` on an external network, and valid keys.",
    examplePaths: ["services.web.networks.backend", "networks.backend.name"],
  },
  "landofile.capability": {
    stages: ["resolve", "planning"],
    severities: ["error", "warning"],
    summary:
      "Compose fields, routes, published ports, bind mounts, builds, storage ownership, native `init`, agent forwarding, and file-sync selection the selected provider cannot realize, checked against its offline capability declaration and final plan. Missing declarations and an unset `init` on a provider without native init are warnings; other findings are errors.",
    examplePaths: ["services.web.networks.default.aliases", "services.web.ports", "services.web.init"],
  },
  "landofile.healthcheck": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "An authored healthcheck `kind: http` or `kind: tcp`, or a final healthcheck execution target, which the healthcheck runner does not support.",
    examplePaths: ["services.web.healthcheck.kind"],
  },
  "landofile.readiness": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "An authored readiness `kind: http` or `kind: tcp`, or a final readiness execution target, which the healthcheck runner does not support.",
    examplePaths: ["services.web.readiness.kind"],
  },
  "landofile.event": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "Each key under `events:` is a lifecycle event or the `pre-` or `post-` bracket of a tooling task.",
    examplePaths: ["events.pre-buidl"],
  },
  "landofile.tooling": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary:
      "No enabled tooling task takes `run`, `scratch`, or a `scratch:*` name, which belong to scratch apps, or a name whose `pre-` or `post-` events Lando reserves, such as `start` or `pull`. Lint-only, so planning does not fail on it: var definitions and task-level service, user, and dir must not read shell-computed vars.",
    examplePaths: ["tooling.run"],
  },
  "landofile.host-shell": {
    stages: ["resolve", "planning", "global-config"],
    severities: ["error"],
    summary:
      "A `:host` tooling or event command, a host readiness command, or a global `hostEvents` command uses a form Bun Shell cannot run, such as `${NAME}`, `$?`, `>&2`, or `>out 2>&1`. The message gives the column and the Bun Shell form to write instead.",
    examplePaths: ["tooling.deploy.cmd", "events.pre-start[0].cmd", "services.web.readiness.command"],
  },
  "landofile.discovery": {
    stages: ["discovery"],
    severities: ["error"],
    summary: "`lando doctor --app` found no Landofile, or conflicting Landofile forms, for the app.",
    examplePaths: ["(root)"],
  },
  "router.bind-address-global-only": {
    stages: ["effective"],
    severities: ["warning"],
    summary:
      "A Landofile `router.bindAddress` does not bind the shared router; the key is installation-wide.",
    examplePaths: ["router.bindAddress"],
  },
  "healthcheck.bare-compose-marker": {
    stages: ["effective"],
    severities: ["warning"],
    summary: "A bare healthcheck argv list starts with `CMD`, `CMD-SHELL`, or `NONE`, which runs literally.",
    examplePaths: ["services.web.healthcheck"],
  },
  "healthcheck.mixed-dialects": {
    stages: ["effective"],
    severities: ["warning"],
    summary:
      "Surviving Lando-only and Compose-only healthcheck fields come from different retained sources; Lando fields win.",
    examplePaths: ["services.web.healthcheck"],
  },
  "healthcheck.execution-target": {
    stages: ["effective", "resolve"],
    severities: ["error"],
    summary: "A native healthcheck selects a host target or an explicit user, which only readiness supports.",
    examplePaths: ["services.web.healthcheck"],
  },
  "readiness.bare-compose-marker": {
    stages: ["effective"],
    severities: ["warning"],
    summary: "A bare readiness argv list starts with `CMD`, `CMD-SHELL`, or `NONE`, which runs literally.",
    examplePaths: ["services.web.readiness"],
  },
  "readiness.mixed-dialects": {
    stages: ["effective"],
    severities: ["warning"],
    summary:
      "Surviving Lando-only and Compose-only readiness fields come from different retained sources; Lando fields win.",
    examplePaths: ["services.web.readiness"],
  },
  "readiness.execution-target": {
    stages: ["effective", "resolve"],
    severities: ["error"],
    summary: "Host readiness sets a container user or listener target, or lacks its own command.",
    examplePaths: ["services.web.readiness"],
  },
  "env-file.read": {
    stages: ["resolve"],
    severities: ["error"],
    summary: "A declared env file is missing or cannot be read.",
    examplePaths: ["env_file[0]", "services.web.envFile[0]"],
  },
  "env-file.syntax": {
    stages: ["resolve"],
    severities: ["error"],
    summary: "Invalid env-file entries, including a bare name without `=` or unmatched quotes.",
    examplePaths: ["env_file[0]", "services.web.envFile[0]"],
  },
  "env-file.literal": {
    stages: ["resolve"],
    severities: ["warning"],
    summary:
      "Double-quoted escapes change a value, or an unquoted or double-quoted value contains `${`, which env files never interpolate.",
    examplePaths: ["env_file[0]", "services.web.envFile[0]"],
  },
  "unsupported-expression": {
    stages: ["load", "global-config"],
    severities: ["error"],
    summary:
      "A `${NAME}` shell parameter, key expression, or other expression form at a site Lando does not expand, in a Landofile or a global `hostEvents` step. Landofile loads report it as the `reason` of `landofile.load`.",
    examplePaths: ["services.web.environment.API_URL", "hostEvents.pre-start[0]"],
  },
  "unsupported-secret-reference": {
    stages: ["load"],
    severities: ["error"],
    summary:
      "A `${secret:...}` reference outside a site that binds secrets. Landofile loads report it as the `reason` of `landofile.load`.",
    examplePaths: ["services.web.command"],
  },
} as const satisfies Readonly<Record<string, ConfigLintRuleDescriptor>>;

export const ConfigLintRuleId = Schema.Union(
  Record.keys(CONFIG_LINT_RULES).map((id) =>
    Schema.Literal(id).annotate({ description: CONFIG_LINT_RULES[id].summary }),
  ),
).annotate({
  identifier: "ConfigLintRuleId",
  title: "Config lint rule identifier",
  description: "Registered configuration diagnostic identifier, with the purpose of each rule.",
});
export type ConfigLintRuleId = typeof ConfigLintRuleId.Type;
