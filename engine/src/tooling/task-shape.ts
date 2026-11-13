import {
  type InvocationProgram,
  bindToolingShellSite,
  compiledValueError,
  dynamicToolingReferenceIssues,
  evaluateInvocationSite,
  replaceSiteValue,
  toolingDataNames,
} from "@lando/landofile/compiled-sites";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import { mapFailures } from "@lando/sdk/command-result";
import { ConfigExpressionError, ToolingCompileError, ToolingInputError } from "@lando/sdk/errors";
import { type ExpressionContext, expressionScopeMembers } from "@lando/sdk/expressions";
import type { Environment, SecretRef } from "@lando/sdk/schema";
import { ToolingTaskShape } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

/** Execution-scoped bindings lowered for the shell command sites of one resolved task. */
export interface ToolingShellBindings {
  /** Generated bindings keyed by `cmd` or `cmds.<index>`. */
  readonly commands: ReadonlyMap<string, Readonly<Record<string, SecretRef>>>;
  /** Generated bindings keyed by the dynamic var whose `sh` produced them. */
  readonly vars: Readonly<Record<string, Readonly<Record<string, SecretRef>>>>;
}

export type DynamicToolingVarResolver<E, R> = (input: {
  readonly name: string;
  readonly command: string;
  readonly task: ToolingTaskShape;
  readonly bindings?: Readonly<Record<string, SecretRef>>;
}) => Effect.Effect<string, E, R>;
const shellSite = (path: readonly (string | number)[]) =>
  (path[0] === "cmd" && path.length === 1) ||
  (path[0] === "cmds" && (path.length === 2 || (path.length === 3 && path[2] === "cmd"))) ||
  (path[0] === "vars" && path[2] === "sh");

const commandKey = (path: readonly (string | number)[]): string | undefined => {
  if (path[0] === "cmd" && path.length === 1) return "cmd";
  if (path[0] === "cmds" && typeof path[1] === "number") return `cmds.${path[1]}`;
  return undefined;
};

export const resolveToolingTaskShape = Effect.fnUntraced(function* <E = never, R = never>(
  task: ToolingTaskShape,
  context: ExpressionContext,
  program: InvocationProgram,
  dynamic?: {
    readonly name: string;
    readonly evaluate: DynamicToolingVarResolver<E, R>;
    readonly register?: (name: string, value: unknown) => Effect.Effect<void>;
    readonly validate?: (task: ToolingTaskShape) => Effect.Effect<void, E, R>;
  },
) {
  const tool = dynamic?.name ?? "<tooling-task>";
  const issue = dynamicToolingReferenceIssues(task, program)[0];
  if (issue !== undefined)
    return yield* Effect.fail(
      new ToolingCompileError({
        tool,
        message: `${["tooling", tool, ...issue.path].join(".")}: ${issue.message}`,
        remediation: issue.suggestion,
      }),
    );
  const names = toolingDataNames(task, program, context.vars);
  const vars: Record<string, unknown> = { ...task.vars, ...context.vars };
  const commandBindings = new Map<string, Record<string, SecretRef>>();
  const varBindings: Record<string, Record<string, SecretRef>> = {};
  const envForSite = (path: readonly (string | number)[]): Environment | undefined => {
    if (path[0] === "vars") {
      const variable = task.vars?.[String(path[1])];
      return typeof variable === "object" ? variable.env : undefined;
    }
    if (path[0] === "cmds" && typeof path[1] === "number") {
      const step = task.cmds?.[path[1]];
      return { ...task.env, ...(typeof step === "object" ? step.env : {}) };
    }
    return task.env;
  };
  const attempt = <A>(site: InvocationProgram[number], run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) => {
        if (cause instanceof ToolingCompileError)
          return new ToolingCompileError({
            tool,
            message: cause.message,
            remediation: cause.remediation,
            ...(cause.source === undefined ? {} : { source: cause.source }),
          });
        if (cause instanceof ToolingInputError) return cause;
        const inputs = ["flags", "args"].flatMap((scope) => {
          const reads = expressionScopeMembers(site.template, scope);
          if (!reads.analyzable) return [scope];
          return [...reads.members]
            .filter(
              (name) =>
                !Object.hasOwn(scope === "flags" ? (context.flags ?? {}) : (context.args ?? {}), name),
            )
            .map((name) => `${scope}.${name}`);
        });
        if (
          cause instanceof ConfigExpressionError &&
          cause.message.includes("missing value") &&
          inputs.length > 0
        )
          return new ToolingInputError({
            tool,
            field: inputs[0],
            message: `${site.source.path.join(".")}: Missing invocation input ${inputs.join(", ")}.`,
            remediation: `Pass the input, declare a default, or wrap the reference at ${site.source.path.join(".")} with default().`,
          });
        return cause instanceof ConfigExpressionError
          ? cause
          : compiledValueError(cause, { filePath: "<tooling-task>", pendingSites: [site] });
      },
    });
  const evaluate = (site: InvocationProgram[number], values = vars) =>
    attempt(site, () => evaluateInvocationSite(site, { ...context, vars: values }));
  const collect = (path: readonly (string | number)[], env: Readonly<Record<string, SecretRef>>) => {
    if (Object.keys(env).length === 0) return;
    const key = commandKey(path);
    if (key !== undefined) {
      commandBindings.set(key, { ...commandBindings.get(key), ...env });
      return;
    }
    if (path[0] === "vars" && typeof path[1] === "string") {
      varBindings[path[1]] = { ...varBindings[path[1]], ...env };
    }
  };
  const evaluateShell = (site: InvocationProgram[number], values = vars) =>
    attempt(site, () =>
      bindToolingShellSite(site, { ...context, vars: values }, names, envForSite(site.path)),
    ).pipe(
      Effect.tap((bound) => Effect.sync(() => collect(site.path, bound.env))),
      Effect.map((bound) => bound.text),
    );
  const visiting = new Set<string>();
  const settled = new Set(Object.keys(context.vars ?? {}));
  const literal = (
    name: string,
  ): Effect.Effect<void, ToolingCompileError | ToolingInputError | ConfigExpressionError> =>
    Effect.suspend(() => {
      const definition = task.vars?.[name];
      if (settled.has(name) || typeof definition === "object" || definition === undefined) return Effect.void;
      if (visiting.has(name))
        return Effect.fail(
          new ToolingCompileError({
            tool,
            message: `tooling.${tool}.vars.${name}: Cyclic literal var definition.`,
            remediation: `Remove the cycle in tooling.${tool}.vars.${name}.`,
          }),
        );
      visiting.add(name);
      const site = program.find(
        (candidate) =>
          candidate.path[0] === "vars" && candidate.path[1] === name && candidate.path.length === 2,
      );
      const reads = site === undefined ? undefined : expressionScopeMembers(site.template, "vars");
      const dependencies =
        reads?.analyzable === false
          ? Object.keys(task.vars ?? {}).filter((key) => key !== name)
          : [...(reads?.members ?? [])];
      return Effect.forEach(dependencies, literal).pipe(
        Effect.andThen(site === undefined ? Effect.succeed(definition) : evaluate(site)),
        Effect.tap((bound) =>
          Effect.sync(() => {
            vars[name] = bound;
            visiting.delete(name);
            settled.add(name);
          }),
        ),
        Effect.asVoid,
      );
    });
  for (const name of Object.keys(task.vars ?? {})) yield* literal(name);
  let value: unknown = task;
  for (const [name, definition] of Object.entries(task.vars ?? {}))
    if (typeof definition !== "object") value = replaceSiteValue(value, ["vars", name], vars[name]);
  const targetSites = program.filter(
    (site) =>
      (site.path.length === 1 && ["service", "user", "dir"].includes(String(site.path[0]))) ||
      (site.path[0] === "vars" && site.path[2] === "service"),
  );
  for (const site of targetSites) value = replaceSiteValue(value, site.path, yield* evaluate(site));
  // A var's own env is authored for it, so resolve those sites before any var command runs.
  for (const site of program.filter((site) => site.path[0] === "vars" && site.path[2] === "env"))
    value = replaceSiteValue(value, site.path, yield* evaluate(site));
  const decode = (value: unknown) =>
    Schema.decodeUnknownEffect(ToolingTaskShape)(value).pipe(
      mapFailures((cause) =>
        compiledValueError(cause, { filePath: "<tooling-task>", pendingSites: program }),
      ),
    );
  const target = yield* decode(value);
  yield* Effect.fromResult(normalizeToolingTask(tool, target));
  yield* dynamic?.validate?.(target) ?? Effect.void;
  const argv = Effect.fnUntraced(function* (values: Record<string, unknown>) {
    const command: string[] = [];
    const authored = typeof task.cmd === "string" ? [] : (task.cmd ?? []);
    for (const [index, entry] of authored.entries()) {
      const site = program.find((site) => site.path[0] === "cmd" && site.path[1] === index);
      const result = site === undefined ? entry : yield* evaluate(site, values);
      if (Array.isArray(result)) {
        if (
          site?.template.whole !== true ||
          site.template.segments[0]?.kind !== "InterpolationSegment" ||
          site.template.segments[0].expression.kind !== "Path" ||
          site.template.segments[0].expression.head !== "raw" ||
          site.template.segments[0].expression.segments.length !== 0 ||
          result.some((part) => typeof part !== "string")
        )
          return yield* Effect.fail(
            new ToolingCompileError({
              tool,
              message: `tooling.${tool}.cmd.${index}: Only a whole {{ raw }} argv element can splice input.`,
              remediation: "Put {{ raw }} alone in an argv element after the executable.",
            }),
          );
        command.push(...result);
      } else command.push(String(result));
    }
    if (!command[0])
      return yield* Effect.fail(
        new ToolingCompileError({
          tool,
          message: `tooling.${tool}.cmd needs a nonempty executable after raw expansion.`,
          remediation: `Keep a literal executable first in tooling.${tool}.cmd.`,
        }),
      );
    return command;
  });
  // Check every shell placement against inert placeholders before the first dynamic command.
  const placeholders = { ...vars };
  for (const [name, definition] of Object.entries(task.vars ?? {}))
    if (typeof definition === "object" && !settled.has(name)) placeholders[name] = "value";
  for (const site of program.filter((site) => shellSite(site.path))) yield* evaluateShell(site, placeholders);
  if (Array.isArray(task.cmd)) yield* argv(placeholders);
  for (const [name, variable] of Object.entries(target.vars ?? {})) {
    if (typeof variable !== "object" || settled.has(name)) continue;
    if (dynamic === undefined)
      return yield* Effect.fail(
        new ToolingCompileError({
          tool,
          message: `tooling.${tool}.vars.${name}.sh has no evaluator.`,
          remediation: "Provide a dynamic var evaluator before resolving this task.",
        }),
      );
    const site = program.find(
      (candidate) => candidate.path[0] === "vars" && candidate.path[1] === name && candidate.path[2] === "sh",
    );
    const command = site === undefined ? variable.sh : yield* evaluateShell(site);
    if (typeof command !== "string")
      return yield* Effect.fail(
        new ToolingCompileError({
          tool,
          message: `tooling.${tool}.vars.${name}.sh must be text.`,
          remediation: `Use a shell command string at tooling.${tool}.vars.${name}.sh.`,
        }),
      );
    vars[name] = yield* dynamic.evaluate({
      name,
      command,
      task: target,
      ...(varBindings[name] === undefined ? {} : { bindings: varBindings[name] }),
    });
    yield* dynamic.register?.(name, vars[name]) ?? Effect.void;
  }
  for (const name of Object.keys(task.vars ?? {}))
    value = replaceSiteValue(value, ["vars", name], vars[name]);
  for (const site of program.filter((site) => site.path[0] !== "vars" && !targetSites.includes(site))) {
    const result = shellSite(site.path) ? yield* evaluateShell(site) : yield* evaluate(site);
    const environment = site.path[0] === "env" || (site.path[0] === "cmds" && site.path[2] === "env");
    value = replaceSiteValue(
      value,
      site.path,
      environment && (typeof result === "number" || typeof result === "boolean") ? String(result) : result,
    );
  }
  if (Array.isArray(task.cmd)) value = replaceSiteValue(value, ["cmd"], yield* argv(vars));
  return {
    task: yield* decode(value),
    bindings: { commands: commandBindings, vars: varBindings } satisfies ToolingShellBindings,
  };
});
