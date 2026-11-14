import type { ToolingCompileError } from "@lando/sdk/errors";
import type {
  Environment,
  ToolingInputDeclaration,
  ToolingTaskShape,
  ValidationIssue,
  ValidationIssuePath,
} from "@lando/sdk/schema";
import { Result } from "effect";
import { inspectToolingInput } from "./tooling-input-normalize.ts";
import { type ToolingInspection, toolingCompileResult } from "./tooling-inspection.ts";

export type { ToolingInspection } from "./tooling-inspection.ts";

export type ToolingServiceRef =
  | { readonly kind: "service"; readonly name: string }
  | { readonly kind: "flag"; readonly flag: string }
  | { readonly kind: "host" };

export interface NormalizedToolingStep {
  readonly cmd: string;
  // Array commands are executable argv; the joined cmd is display-only, never shell source.
  readonly argv?: readonly string[];
  readonly service?: ToolingServiceRef;
  readonly dir?: string;
  readonly user?: string;
  readonly env: Environment;
}

export interface NormalizedToolingTask {
  readonly name: string;
  readonly summary?: string;
  readonly service?: ToolingServiceRef;
  readonly user?: string;
  readonly dir?: string;
  readonly env: Environment;
  readonly disabled: boolean;
  readonly input: ToolingInputDeclaration;
  readonly wrapper: boolean;
  readonly steps: readonly NormalizedToolingStep[];
  readonly source?: { readonly path: string; readonly task: string };
}

export const inspectToolingTask = (
  name: string,
  task: ToolingTaskShape,
  source?: { readonly path: string },
): ToolingInspection<NormalizedToolingTask> => {
  const provenance = source === undefined ? {} : { source: { path: source.path, task: name } };
  const input = inspectToolingInput(task);
  const issues: ValidationIssue[] = Result.isFailure(input) ? [...input.failure] : [];
  const report = (path: ValidationIssuePath, message: string) => {
    issues.push({ path, message, suggestion: "Correct this tooling declaration." });
  };
  const inspectEnv = (env: Environment | undefined, path: ValidationIssuePath) => {
    for (const key of Object.keys(env ?? {})) {
      if (key === "LANDO" || key.startsWith("LANDO_"))
        report([...path, key], "Tooling env must not override reserved runtime keys.");
    }
  };
  inspectEnv(task.env, ["env"]);
  if (task.wrapper === true) {
    if (Object.keys(task.flags ?? {}).length > 0 || Object.keys(task.args ?? {}).length > 0)
      report(
        ["wrapper"],
        "A wrapper task declares no flags or args; remove those declarations or remove wrapper.",
      );
    if (task.arguments === false)
      report(["wrapper"], "A wrapper task accepts arguments; remove arguments: false or remove wrapper.");
  }
  const serviceRef = (
    value: string | undefined,
    path: ValidationIssuePath,
  ): ToolingServiceRef | undefined => {
    if (value === undefined) return undefined;
    if (value === ":host") return { kind: "host" };
    if (!value.startsWith(":")) return { kind: "service", name: value };
    const key = value.slice(1);
    const flag = Object.hasOwn(task.flags ?? {}, key) ? task.flags?.[key] : undefined;
    if (flag === undefined || flag.boolean === true) {
      report(path, "Service reference requires a declared non-boolean flag.");
      return undefined;
    }
    return { kind: "flag", flag: key };
  };
  const service = serviceRef(task.service, ["service"]);
  for (const [key, variable] of Object.entries(task.vars ?? {})) {
    if (typeof variable !== "object") continue;
    serviceRef(variable.service, ["vars", key, "service"]);
    inspectEnv(variable.env, ["vars", key, "env"]);
  }
  const env = { ...task.env };
  const conflictingCommands = task.cmd !== undefined && task.cmds !== undefined;
  if (conflictingCommands) report(["cmds"], "Use cmd or cmds, not both.");
  const steps: NormalizedToolingStep[] = [];
  if (task.cmd !== undefined) {
    steps.push({
      cmd: typeof task.cmd === "string" ? task.cmd : task.cmd.join(" "),
      ...(typeof task.cmd === "string" ? {} : { argv: [...task.cmd] }),
      ...(service === undefined ? {} : { service }),
      ...(task.dir === undefined ? {} : { dir: task.dir }),
      ...(task.user === undefined ? {} : { user: task.user }),
      env: { ...env },
    });
  }
  for (const [index, entry] of (task.cmds ?? []).entries()) {
    const step = typeof entry === "string" ? { cmd: entry } : entry;
    const path = ["cmds", index];
    inspectEnv(step.env, [...path, "env"]);
    const target = step.service === undefined ? service : serviceRef(step.service, [...path, "service"]);
    if (typeof step.cmd !== "string" || step.cmd.trim().length === 0) {
      report(typeof entry === "string" ? path : [...path, "cmd"], "Each command step needs a non-empty cmd.");
      continue;
    }
    const dir = step.dir ?? task.dir;
    const user = step.user ?? task.user;
    steps.push({
      cmd: step.cmd,
      ...(target === undefined ? {} : { service: target }),
      ...(dir === undefined ? {} : { dir }),
      ...(user === undefined ? {} : { user }),
      env: {
        ...env,
        ...step.env,
      },
    });
  }
  const summary = task.description ?? task.summary;
  if (
    task.wrapper === true &&
    !conflictingCommands &&
    (task.cmd === undefined ? (task.cmds?.length ?? 0) : 1) !== 1
  )
    report(
      ["wrapper"],
      "A wrapper task runs exactly one command; move setup into its own task or remove wrapper.",
    );
  const [first, ...rest] = issues;
  if (first !== undefined) return Result.fail([first, ...rest]);
  if (Result.isFailure(input)) return Result.fail(input.failure);
  return Result.succeed({
    name,
    ...(summary === undefined ? {} : { summary }),
    ...(service === undefined ? {} : { service }),
    ...(task.user === undefined ? {} : { user: task.user }),
    ...(task.dir === undefined ? {} : { dir: task.dir }),
    env,
    disabled: task.disabled ?? false,
    input: input.success,
    wrapper: task.wrapper ?? false,
    steps,
    ...provenance,
  });
};

export const normalizeToolingTask = (
  name: string,
  task: ToolingTaskShape,
  source?: { readonly path: string },
): Result.Result<NormalizedToolingTask, ToolingCompileError> =>
  toolingCompileResult(name, inspectToolingTask(name, task, source), source);

export const requiresProvider = (task: NormalizedToolingTask): boolean =>
  !task.steps.every((step) => (step.service ?? task.service)?.kind === "host");
