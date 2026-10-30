import { ToolingCompileError } from "@lando/sdk/errors";
import type { Environment, ToolingInputDeclaration, ToolingTaskShape } from "@lando/sdk/schema";
import { Result } from "effect";
import { normalizeToolingInput } from "./tooling-input-normalize.ts";

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
  readonly steps: readonly NormalizedToolingStep[];
  readonly source?: { readonly path: string; readonly task: string };
}

export const normalizeToolingTask = (
  name: string,
  task: ToolingTaskShape,
  source?: { readonly path: string },
): Result.Result<NormalizedToolingTask, ToolingCompileError> => {
  const provenance = source === undefined ? {} : { source: { path: source.path, task: name } };
  const fail = (message: string) =>
    Result.fail(
      new ToolingCompileError({
        message,
        tool: name,
        ...provenance,
        remediation: `Correct the tooling declaration for ${name}: ${message}`,
      }),
    );
  const authoredEnvironments = [
    task.env,
    ...(task.cmds ?? []).map((step) => (typeof step === "string" ? undefined : step.env)),
  ];
  const reserved = authoredEnvironments.flatMap((env) =>
    Object.keys(env ?? {}).filter((key) => key === "LANDO" || key.startsWith("LANDO_")),
  );
  if (reserved.length > 0)
    return fail(`Tooling env must not override reserved runtime keys: ${reserved.join(", ")}.`);
  const input = normalizeToolingInput(name, task, source);
  if (Result.isFailure(input)) return Result.fail(input.failure);
  const serviceRef = (
    value: string | undefined,
  ): Result.Result<ToolingServiceRef | undefined, ToolingCompileError> => {
    if (value === undefined) return Result.succeed(undefined);
    if (value === ":host") return Result.succeed({ kind: "host" });
    if (!value.startsWith(":")) return Result.succeed({ kind: "service", name: value });
    const key = value.slice(1);
    const flag = input.success.flags.find((candidate) => candidate.name === key);
    if (flag === undefined || flag.boolean)
      return fail(`Service reference ${value} requires a declared non-boolean flag.`);
    return Result.succeed({ kind: "flag", flag: key });
  };
  const service = serviceRef(task.service);
  if (Result.isFailure(service)) return Result.fail(service.failure);
  const env = { ...task.env };
  if (task.cmd !== undefined && task.cmds !== undefined) return fail("Use cmd or cmds, not both.");
  const steps: NormalizedToolingStep[] = [];
  if (task.cmd !== undefined) {
    steps.push({
      cmd: typeof task.cmd === "string" ? task.cmd : task.cmd.join(" "),
      ...(typeof task.cmd === "string" ? {} : { argv: [...task.cmd] }),
      ...(service.success === undefined ? {} : { service: service.success }),
      ...(task.dir === undefined ? {} : { dir: task.dir }),
      ...(task.user === undefined ? {} : { user: task.user }),
      env: { ...env },
    });
  }
  for (const entry of task.cmds ?? []) {
    const step = typeof entry === "string" ? { cmd: entry } : entry;
    if (typeof step.cmd !== "string" || step.cmd.trim().length === 0)
      return fail("Each command step needs a non-empty cmd.");
    const target = serviceRef(step.service ?? task.service);
    if (Result.isFailure(target)) return Result.fail(target.failure);
    const dir = step.dir ?? task.dir;
    const user = step.user ?? task.user;
    steps.push({
      cmd: step.cmd,
      ...(target.success === undefined ? {} : { service: target.success }),
      ...(dir === undefined ? {} : { dir }),
      ...(user === undefined ? {} : { user }),
      env: {
        ...env,
        ...step.env,
      },
    });
  }
  const summary = task.description ?? task.summary;
  return Result.succeed({
    name,
    ...(summary === undefined ? {} : { summary }),
    ...(service.success === undefined ? {} : { service: service.success }),
    ...(task.user === undefined ? {} : { user: task.user }),
    ...(task.dir === undefined ? {} : { dir: task.dir }),
    env,
    disabled: task.disabled ?? false,
    input: input.success,
    steps,
    ...provenance,
  });
};

export const requiresProvider = (task: NormalizedToolingTask): boolean =>
  !task.steps.every((step) => (step.service ?? task.service)?.kind === "host");
