import type { LandofileProvenance } from "@lando/landofile/provenance";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import { getLandofileValueSource, landofileValidationError, pathsOverlap } from "@lando/landofile/validation";
import { type ExpressionTemplate, parseExpressionEither } from "@lando/sdk/expressions";
import type {
  ConfigLintRuleId,
  EventStep,
  HostEvents,
  LandofileShape,
  ValidationIssue,
  ValidationIssuePath,
} from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import {
  type BunShellDialectIssue,
  bunShellDialectIssues,
  describeBunShellIssue,
} from "../services/bun-shell-dialect.ts";
import { compileEventStepLeaf } from "../tooling/step-compiler.ts";
import type { EffectiveTooling } from "./effective-tooling.ts";
import { RESERVED_EVENT_NAMES } from "./event-names.ts";
import { pathIsBlocked } from "./landofile-scopes.ts";
import type { PlannerIssue } from "./resolved-validation.ts";
import { enabledToolingEntries } from "./tooling-composition.ts";
import { type EffectiveToolingResolution, toolingIssueSource } from "./tooling-provenance.ts";

const RULE = "landofile.host-shell";

/** An authored expression site; only `{{ ... }}` interpolations change command text at invocation. */
export interface HostShellSite {
  readonly path: readonly (string | number)[];
  readonly template: Pick<ExpressionTemplate, "segments">;
}

/** Planner resolution fields needed for host-shell static checks. */
export interface HostShellResolution {
  readonly landofile: LandofileShape;
  readonly provenance?: LandofileProvenance | undefined;
  readonly toolingResolution: EffectiveToolingResolution;
  /** Load-failure destinations; deferred expressions are tracked separately in `sites`. */
  readonly blocked?: readonly ValidationIssuePath[] | undefined;
}

/** A host command Lando can check before it runs. */
export interface HostCommand {
  readonly path: ValidationIssuePath;
  readonly command: string;
}

/** True when a `{{ ... }}` site inside `path` will change the command text at invocation. */
const isDynamic = (sites: readonly HostShellSite[], path: ValidationIssuePath): boolean =>
  sites.some(
    (site) =>
      pathsOverlap(path, site.path) &&
      site.template.segments.some((segment) => segment.kind === "InterpolationSegment"),
  );

const toolingCommandPath = (
  name: string,
  task: EffectiveTooling[string],
  index: number,
): ValidationIssuePath => {
  if (task.cmd !== undefined) return ["tooling", name, "cmd"];
  return typeof task.cmds?.[index] === "string"
    ? ["tooling", name, "cmds", index]
    : ["tooling", name, "cmds", index, "cmd"];
};

/** Host string commands of enabled tooling tasks, as the tooling normalizer sees them. */
export const hostToolingCommands = (
  tooling: EffectiveTooling,
  sites: readonly HostShellSite[],
): ReadonlyArray<HostCommand> =>
  enabledToolingEntries(tooling).flatMap(([name, task]) => {
    const normalized = normalizeToolingTask(name, task);
    if (Result.isFailure(normalized)) return [];
    const variables = Object.entries(task.vars ?? {}).flatMap(([key, value]) => {
      const path = ["tooling", name, "vars", key, "sh"];
      return typeof value === "object" &&
        (value.service === ":host" ||
          (value.service === undefined && normalized.success.service?.kind === "host")) &&
        (sites.length === 0 ||
          (!isDynamic(sites, path) &&
            !isDynamic(sites, ["tooling", name, "vars", key, "service"]) &&
            (value.service !== undefined || !isDynamic(sites, ["tooling", name, "service"]))))
        ? [{ path, command: value.sh }]
        : [];
    });
    return [
      ...variables,
      ...normalized.success.steps.flatMap((step, index) => {
        const path = toolingCommandPath(name, task, index);
        return (step.service ?? normalized.success.service)?.kind === "host" &&
          step.argv === undefined &&
          (sites.length === 0 ||
            (!isDynamic(sites, path) &&
              !isDynamic(sites, ["tooling", name, "cmds", index, "service"]) &&
              (step.service !== undefined || !isDynamic(sites, ["tooling", name, "service"]))))
          ? [{ path, command: step.cmd }]
          : [];
      }),
    ];
  });

/** Host string commands of event steps, as the event step compiler sees them. */
export const hostEventCommands = (
  events: Readonly<Record<string, ReadonlyArray<EventStep> | undefined>>,
  sites: readonly HostShellSite[],
  root: "events" | "hostEvents" = "events",
): ReadonlyArray<HostCommand> =>
  Object.entries(events).flatMap(([name, steps]) =>
    (steps ?? []).flatMap((step, index) => {
      const leaf = compileEventStepLeaf(step, index);
      if (typeof step === "string" || leaf.kind !== "cmd" || leaf.service !== ":host") return [];
      const path = [root, name, index, "cmd" in step && step.cmd !== undefined ? "cmd" : "defer"];
      return sites.length > 0 && (isDynamic(sites, path) || isDynamic(sites, [root, name, index, "service"]))
        ? []
        : [{ path, command: leaf.command }];
    }),
  );

const findings = (
  command: HostCommand,
  keep: (issue: BunShellDialectIssue) => boolean = () => true,
): ReadonlyArray<ValidationIssue & { readonly rule: ConfigLintRuleId }> =>
  bunShellDialectIssues(command.command)
    .filter(keep)
    .map((dialect) => ({
      rule: RULE,
      path: [...command.path],
      message: describeBunShellIssue(dialect),
      suggestion: dialect.suggestion,
    }));

/**
 * Lint findings for host Bun Shell commands in effective tooling and Landofile events. A field
 * whose text still holds a `{{ ... }}` invocation site is left to the check at execution.
 */
export const hostShellIssues = (
  resolution: HostShellResolution,
  sites: readonly HostShellSite[],
): ReadonlyArray<PlannerIssue> => {
  const { landofile } = resolution;
  const blocked = resolution.blocked;
  const { tasks, provenance } = resolution.toolingResolution;
  return [...hostToolingCommands(tasks, sites), ...hostEventCommands(landofile.events ?? {}, sites)].flatMap(
    (command) => {
      if (pathIsBlocked(blocked, command.path)) return [];
      const source =
        command.path[0] === "tooling"
          ? toolingIssueSource(provenance, String(command.path[1]), command.path.slice(2))
          : getLandofileValueSource(resolution.provenance, command.path);
      return findings(command).map((issue) => (source === undefined ? issue : { ...issue, source }));
    },
  );
};

/**
 * Planning subset: host steps of app lifecycle and remote-hook events, which run during lifecycle
 * operations. A broken tooling task or task hook fails only when it runs.
 */
export const planningHostShellIssues = (
  resolution: HostShellResolution,
  sites: readonly HostShellSite[],
): ReadonlyArray<PlannerIssue> =>
  hostShellIssues(resolution, sites).filter(
    (entry) => typeof entry.path[1] === "string" && RESERVED_EVENT_NAMES.has(entry.path[1]),
  );

/** Authored host readiness string command findings. */
export const hostReadinessShellIssues = (
  provenance: LandofileProvenance | undefined,
  serviceName: string,
  command: string,
  blocked?: (path: ValidationIssuePath) => boolean,
): ReadonlyArray<PlannerIssue> => {
  const path: ValidationIssuePath = ["services", serviceName, "readiness", "command"];
  if (blocked?.(path)) return [];
  const source = getLandofileValueSource(provenance, path);
  return findings({ path, command }).map((issue) => (source === undefined ? issue : { ...issue, source }));
};

/**
 * The text a host-wide `hostEvents` command hands to Bun Shell. `${secret:NAME}` becomes a
 * placeholder (and `${NAME}` too, which `hostEventExpressionIssues` reports separately); `$${` is
 * already literal text. A command with a `{{ ... }}` interpolation is checked when it runs instead.
 */
const hostEventRunText = (command: string): string | undefined => {
  const parsed = parseExpressionEither(command, { filePath: "config.yml", bareShellParameters: "preserve" });
  if (Result.isFailure(parsed)) return undefined;
  const { segments } = parsed.success;
  if (segments.some((segment) => segment.kind === "InterpolationSegment")) return undefined;
  return segments.map((segment) => (segment.kind === "LiteralSegment" ? segment.text : "_")).join("");
};

/**
 * `${NAME}` forms and unreadable expressions in any `hostEvents` step. Lando never expands `${NAME}`
 * there, as in a Landofile, so the step would otherwise run with the text removed.
 */
const hostEventExpressionIssues = (
  hostEvents: HostEvents,
): ReadonlyArray<ValidationIssue & { readonly rule: ConfigLintRuleId }> =>
  Object.entries(hostEvents).flatMap(([event, steps]) =>
    (steps ?? []).flatMap((step, index) => {
      const command = typeof step === "string" ? step : "cmd" in step ? step.cmd : undefined;
      if (command === undefined || (!command.includes("${") && !command.includes("{{"))) return [];
      const path =
        typeof step === "string" ? ["hostEvents", event, index] : ["hostEvents", event, index, "cmd"];
      const parsed = parseExpressionEither(command, {
        filePath: "config.yml",
        bareShellParameters: "preserve",
      });
      if (Result.isFailure(parsed))
        return [
          {
            rule: "unsupported-expression",
            path,
            message: parsed.failure.message,
            suggestion: parsed.failure.remediation,
          },
        ];
      const parameter = parsed.success.segments.find((segment) => segment.kind === "ShellParamSegment");
      if (parameter === undefined) return [];
      const { name } = parameter;
      const shell =
        typeof step !== "string" && step.service === ":host" ? "the host shell" : "the service shell";
      const hostValue =
        parameter.operator === "plain" ? `{{ env.${name} }}` : `{{ default(env.${name}, 'fallback') }}`;
      return [
        {
          rule: "unsupported-expression",
          path,
          message: `Lando does not expand \${${name}${parameter.operator === "plain" ? "" : "..."}} in hostEvents.`,
          suggestion: `Write $${name} for ${shell} to read it when the step runs, or ${hostValue} for your host's value when Lando plans the app.`,
        },
      ];
    }),
  );

/**
 * Findings for `hostEvents`: unsupported `${NAME}` forms in any step, and Bun Shell dialect issues in
 * `:host` commands at `hostEvents.<event>[i].cmd`. Config loading already rejects an unbalanced
 * quote in any step, so that finding isn't repeated here.
 */
export const hostEventsShellIssues = (
  hostEvents: HostEvents,
): ReadonlyArray<ValidationIssue & { readonly rule: ConfigLintRuleId }> => {
  const events = Object.keys(hostEvents);
  return [
    ...hostEventExpressionIssues(hostEvents),
    ...hostEventCommands(hostEvents, [], "hostEvents").flatMap((command) => {
      const text = hostEventRunText(command.command);
      return text === undefined
        ? []
        : findings(
            { path: command.path, command: text },
            (issue) => issue.text !== "'" && issue.text !== '"',
          );
    }),
  ].sort(
    (left, right) =>
      events.indexOf(String(left.path[1])) - events.indexOf(String(right.path[1])) ||
      Number(left.path[2]) - Number(right.path[2]),
  );
};

/**
 * Every hostEvents name is a lifecycle event, so a bad host step stops the app's plan like a project
 * lifecycle step would; commands that only read config are unaffected. Checked before the steps
 * compile, so an unreadable expression is reported against config.yml.
 */
export const checkHostEventsShell = (hostEvents: HostEvents, configFile: string) => {
  const issues = hostEventsShellIssues(hostEvents).map((issue) => ({
    ...issue,
    source: { layer: "config-file" as const, file: configFile, path: issue.path },
  }));
  return issues.length === 0
    ? Effect.void
    : Effect.fail(
        landofileValidationError(configFile, issues, {
          headline: "Global config hostEvents has steps that cannot run as written",
          remediation: "Fix each listed hostEvents step in config.yml, then rerun the command.",
        }),
      );
};
