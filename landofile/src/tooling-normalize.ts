import { ToolingCompileError } from "@lando/sdk/errors";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import { Either } from "effect";

export type ToolingServiceRef =
  | { readonly kind: "service"; readonly name: string }
  | { readonly kind: "flag"; readonly flag: string }
  | { readonly kind: "host" };

export interface NormalizedToolingFlag {
  readonly name: string;
  readonly alias?: string;
  readonly boolean: boolean;
  readonly choices?: readonly string[];
  readonly default?: string | boolean;
  readonly required: boolean;
  readonly description?: string;
}

export interface NormalizedToolingArg {
  readonly name: string;
  readonly order: number;
  readonly choices?: readonly string[];
  readonly default?: string;
  readonly required: boolean;
  readonly description?: string;
}

export interface NormalizedToolingStep {
  readonly cmd: string;
  // Array commands are executable argv; the joined cmd is display-only, never shell source.
  readonly argv?: readonly string[];
  readonly service?: ToolingServiceRef;
  readonly dir?: string;
  readonly user?: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface NormalizedToolingTask {
  readonly name: string;
  readonly summary?: string;
  readonly service?: ToolingServiceRef;
  readonly user?: string;
  readonly dir?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly hasInput: boolean;
  readonly acceptsArguments: boolean;
  readonly flags: readonly NormalizedToolingFlag[];
  readonly args: readonly NormalizedToolingArg[];
  readonly steps: readonly NormalizedToolingStep[];
  readonly source?: { readonly path: string; readonly task: string };
}

export const normalizeToolingTask = (
  name: string,
  task: ToolingTaskShape,
  source?: { readonly path: string },
): Either.Either<NormalizedToolingTask, ToolingCompileError> => {
  const provenance = source === undefined ? {} : { source: { path: source.path, task: name } };
  const fail = (message: string) =>
    Either.left(
      new ToolingCompileError({
        message,
        tool: name,
        ...provenance,
        remediation: `Correct the tooling declaration for ${name}: ${message}`,
      }),
    );
  const flags: NormalizedToolingFlag[] = [];
  const flagEntries = Object.entries(task.flags ?? {});
  const names = new Set(flagEntries.map(([key]) => key));
  const aliases = new Set<string>();
  for (const [key, flag] of flagEntries) {
    if (flag.alias !== undefined) {
      if (names.has(flag.alias) || aliases.has(flag.alias)) return fail(`Flag alias ${flag.alias} collides.`);
      aliases.add(flag.alias);
    }
    if (flag.required === true && flag.default !== undefined)
      return fail(`Required flag ${key} has a default.`);
    if (flag.boolean === true && flag.choices !== undefined)
      return fail(`Boolean flag ${key} declares choices.`);
    if (
      flag.default !== undefined &&
      flag.choices !== undefined &&
      !flag.choices.includes(String(flag.default))
    ) {
      return fail(`Default for flag ${key} is outside its choices.`);
    }
    if (flag.boolean === true && flag.default !== undefined && typeof flag.default !== "boolean") {
      return fail(`Boolean flag ${key} needs a boolean default.`);
    }
    flags.push({
      name: key,
      boolean: flag.boolean ?? false,
      required: flag.required ?? false,
      ...(flag.alias === undefined ? {} : { alias: flag.alias }),
      ...(flag.description === undefined ? {} : { description: flag.description }),
      ...(flag.choices === undefined ? {} : { choices: [...flag.choices] }),
      ...(flag.default === undefined
        ? {}
        : {
            default:
              flag.boolean === true && typeof flag.default === "boolean"
                ? flag.default
                : String(flag.default),
          }),
    });
  }
  const argEntries = Object.entries(task.args ?? {});
  const ordered = argEntries.some(([, arg]) => arg.order !== undefined);
  if (ordered && argEntries.some(([, arg]) => arg.order === undefined))
    return fail("Every argument must declare order when any argument does.");
  const args: NormalizedToolingArg[] = [];
  const orders = new Set<number>();
  for (const [index, [key, arg]] of argEntries.entries()) {
    const order = arg.order ?? index;
    if (orders.has(order)) return fail(`Argument order ${order} is duplicated.`);
    orders.add(order);
    if (arg.required === true && arg.default !== undefined)
      return fail(`Required argument ${key} has a default.`);
    if (
      arg.default !== undefined &&
      arg.choices !== undefined &&
      !arg.choices.includes(String(arg.default))
    ) {
      return fail(`Default for argument ${key} is outside its choices.`);
    }
    args.push({
      name: key,
      order,
      required: arg.required ?? false,
      ...(arg.description === undefined ? {} : { description: arg.description }),
      ...(arg.choices === undefined ? {} : { choices: [...arg.choices] }),
      ...(arg.default === undefined ? {} : { default: String(arg.default) }),
    });
  }
  args.sort((a, b) => a.order - b.order);
  let optionalSeen = false;
  for (const arg of args) {
    if (optionalSeen && arg.required)
      return fail(`Required argument ${arg.name} follows an optional argument.`);
    optionalSeen ||= !arg.required;
  }
  const serviceRef = (
    value: string | undefined,
  ): Either.Either<ToolingServiceRef | undefined, ToolingCompileError> => {
    if (value === undefined) return Either.right(undefined);
    if (value === ":host") return Either.right({ kind: "host" });
    if (!value.startsWith(":")) return Either.right({ kind: "service", name: value });
    const key = value.slice(1);
    const flag = flags.find((candidate) => candidate.name === key);
    if (flag === undefined || flag.boolean)
      return fail(`Service reference ${value} requires a declared non-boolean flag.`);
    return Either.right({ kind: "flag", flag: key });
  };
  const service = serviceRef(task.service);
  if (Either.isLeft(service)) return Either.left(service.left);
  const env = Object.fromEntries(Object.entries(task.env ?? {}).map(([key, value]) => [key, String(value)]));
  if (task.cmd !== undefined && task.cmds !== undefined) return fail("Use cmd or cmds, not both.");
  const steps: NormalizedToolingStep[] = [];
  if (task.cmd !== undefined) {
    steps.push({
      cmd: typeof task.cmd === "string" ? task.cmd : task.cmd.join(" "),
      ...(typeof task.cmd === "string" ? {} : { argv: [...task.cmd] }),
      ...(service.right === undefined ? {} : { service: service.right }),
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
    if (Either.isLeft(target)) return Either.left(target.left);
    const dir = step.dir ?? task.dir;
    const user = step.user ?? task.user;
    steps.push({
      cmd: step.cmd,
      ...(target.right === undefined ? {} : { service: target.right }),
      ...(dir === undefined ? {} : { dir }),
      ...(user === undefined ? {} : { user }),
      env: {
        ...env,
        ...Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, String(value)])),
      },
    });
  }
  const summary = task.description ?? task.summary;
  return Either.right({
    name,
    ...(summary === undefined ? {} : { summary }),
    ...(service.right === undefined ? {} : { service: service.right }),
    ...(task.user === undefined ? {} : { user: task.user }),
    ...(task.dir === undefined ? {} : { dir: task.dir }),
    env,
    disabled: task.disabled ?? false,
    hasInput: flags.length + args.length > 0,
    acceptsArguments: task.arguments !== false,
    flags,
    args,
    steps,
    ...provenance,
  });
};

export const requiresProvider = (task: NormalizedToolingTask): boolean =>
  !task.steps.every((step) => (step.service ?? task.service)?.kind === "host");
