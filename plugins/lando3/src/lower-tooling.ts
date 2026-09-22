/**
 * Lando 3 `tooling:` as Lando 4 tooling tasks.
 *
 * Lando 3 registered a task only when its value was a mapping, so any other
 * value removes the task and becomes `disabled: true`. Positional arguments
 * written into the task name, yargs `options`, and `positionals` become
 * declared `args` and `flags`. A command list becomes ordered `cmds` steps,
 * with `{service: command}` entries as service-targeted step objects.
 */
import { isLegacyTagged } from "@lando/sdk/landofile";
import type { Lando3Path } from "./contract.ts";
import { lowerFlags, lowerPositionals } from "./lower-tooling-input.ts";
import { type V4Wire, asStringArray, isPlainObject } from "./lowering-contract.ts";
import { type Report, lowerText } from "./lowering-report.ts";

/** What the events lowerer needs to know about one converted task. */
export interface LoweredTask {
  /** Service a bare event command inherits: the fixed service, or the dynamic flag default. */
  readonly service: string | undefined;
}

export interface LoweredTooling {
  readonly tooling: Readonly<Record<string, V4Wire>>;
  readonly tasks: ReadonlyMap<string, LoweredTask>;
}

const TASK_NAME = /^([^\s[\]<>]+)((?:\s+(?:\[[^\]\s]+\]|<[^>\s]+>))*)\s*$/u;
const POSITIONAL_PARAMETER = /\$(?:[0-9@*#]|\{[0-9@*#])/u;
const TRAILING_BACKGROUND = /(?<![&|])&\s*$/u;
const RESERVED_ENV = /^LANDO(?:_|$)/u;

interface Step {
  readonly cmd: string;
  readonly service?: string;
}

const lowerCommands = (value: unknown, path: Lando3Path, report: Report): ReadonlyArray<Step> | undefined => {
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];
  const steps: Step[] = [];
  let failed = false;
  items.forEach((item, index) => {
    const itemPath = Array.isArray(value) ? [...path, index] : path;
    if (isPlainObject(item) && !isLegacyTagged(item)) {
      const [service, command, ...extra] = Object.entries(item).flat();
      const cmd = lowerText(command, [...itemPath, String(service)], report);
      if (typeof service !== "string" || typeof cmd !== "string") {
        failed = true;
        if (cmd === null) return;
        report(
          "unsupported",
          itemPath,
          "A {service: command} entry must map one service to one command string.",
          "Split the entry into one command string per service before converting.",
        );
        return;
      }
      for (let index = 0; index < extra.length; index += 2) {
        report(
          "dropped",
          [...itemPath, String(extra[index])],
          "Lando 3 ran only the first service of a {service: command} entry and ignored this one.",
          "Add a separate command entry for this service if it should run.",
        );
      }
      steps.push({ cmd, service });
      return;
    }
    const cmd = lowerText(item, itemPath, report);
    if (typeof cmd !== "string") {
      failed = true;
      if (cmd === undefined) {
        report(
          "unsupported",
          itemPath,
          "A tooling command must be a string or a {service: command} entry.",
          "Rewrite the command as a string before converting.",
        );
      }
      return;
    }
    if (typeof item === "string" && TRAILING_BACKGROUND.test(cmd)) {
      report(
        "dropped",
        itemPath,
        "Lando 3 ran this command in the background; Lando 4 runs it in the foreground.",
        "Start long-running processes from the service's own command, or background them inside a script.",
      );
      steps.push({ cmd: cmd.replace(TRAILING_BACKGROUND, "").trimEnd() });
      return;
    }
    steps.push({ cmd });
  });
  return failed ? undefined : steps;
};

const lowerEnv = (value: unknown, path: Lando3Path, report: Report): V4Wire | undefined => {
  const entries: Array<readonly [string, unknown]> = isPlainObject(value)
    ? Object.entries(value)
    : (asStringArray(value) ?? []).map((pair) => {
        const equals = pair.indexOf("=");
        return equals < 0 ? [pair, ""] : [pair.slice(0, equals), pair.slice(equals + 1)];
      });
  const env: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    const entryPath = [...path, key];
    if (RESERVED_ENV.test(key)) {
      report(
        "dropped",
        entryPath,
        `${key} is reserved by Lando 4 and cannot be set on a tooling task.`,
        "Rename the variable, or rely on the value Lando 4 provides.",
      );
      continue;
    }
    const text = lowerText(entry, entryPath, report);
    if (text === null) continue;
    if (text !== undefined) env[key] = text;
    else if (typeof entry === "number" || typeof entry === "boolean") env[key] = entry;
    else {
      report(
        "dropped",
        entryPath,
        "Tooling environment values must be strings, numbers, or booleans.",
        "Set a scalar value for this variable in the generated Landofile.",
      );
    }
  }
  return Object.keys(env).length === 0 ? undefined : env;
};

const DROPPED_TASK_KEYS: Readonly<Record<string, readonly [string, string]>> = {
  level: [
    "Lando 4 has no tooling level; every task runs against the loaded app.",
    'Run app-independent helpers from a host script or a task with service: ":host".',
  ],
  usage: [
    "Lando 4 builds usage text from the task's flags and args.",
    "Describe expected input in the task description, flags, and args.",
  ],
  examples: [
    "Lando 4 tooling has no examples field.",
    "Move the examples into the task description or project documentation.",
  ],
  interactive: [
    "Lando 4 tooling does not prompt for input.",
    "Pass values as flags or arguments, or give them defaults.",
  ],
};

const lowerTask = (
  name: string,
  positionalTokens: string,
  entry: Record<string, unknown>,
  path: Lando3Path,
  report: Report,
): { readonly task: V4Wire; readonly facts: LoweredTask } | undefined => {
  const task: Record<string, unknown> = {};
  const options = isPlainObject(entry.options) ? entry.options : {};
  let service: string | undefined;
  let serviceFlag: { readonly source: string; readonly target: string } | undefined;
  if (typeof entry.service === "string" && entry.service.startsWith(":")) {
    const flag = entry.service.slice(1);
    const option = options[flag];
    if (!isPlainObject(option) || option.boolean === true || option.type === "boolean") {
      report(
        "unsupported",
        [...path, "service"],
        `service: ${entry.service} reads the service from option ${flag}, which this task does not declare as a value option.`,
        `Declare a ${flag} option, or set a fixed service before converting.`,
      );
      return undefined;
    }
    serviceFlag = { source: flag, target: flag === "host" ? "host-service" : flag };
    task.service = `:${serviceFlag.target}`;
    report(
      flag === "host" ? "needs-review" : "rewritten",
      [...path, "service"],
      flag === "host"
        ? 'The host option became the host-service flag, because service: ":host" runs on the host in Lando 4. Lando 4 also forwards the flag to the command as --host-service=<value>.'
        : `service: ${entry.service} reads the service from the ${flag} flag. Lando 4 also forwards the flag to the command as --${flag}=<value>.`,
      "Check that the command tolerates the forwarded flag.",
    );
    service = typeof option.default === "string" ? option.default : undefined;
  } else if (typeof entry.service === "string") {
    task.service = entry.service;
    service = entry.service;
  } else if (entry.service !== undefined) {
    report(
      "unsupported",
      [...path, "service"],
      "A tooling service must be a single service name.",
      "Choose one service, or split the task into one step per service.",
    );
    return undefined;
  }

  const description = lowerText(entry.description, [...path, "description"], report);
  if (typeof description === "string") task.description = description;

  const commands = lowerCommands(entry.cmd ?? name, [...path, "cmd"], report);
  if (commands === undefined) return undefined;
  if (entry.cmd === undefined) {
    report(
      "generated",
      path,
      `Lando 3 ran the task name as its command, so the task runs ${name}.`,
      "Review the generated cmd.",
    );
  }
  const [first] = commands;
  if (commands.length === 1 && first !== undefined && first.service === undefined) task.cmd = first.cmd;
  else {
    task.cmds = commands.map((step) => (step.service === undefined ? step.cmd : { ...step }));
    report(
      "rewritten",
      [...path, "cmd"],
      "The command list became ordered cmds steps. Lando 4 passes caller arguments to the last step only; Lando 3 appended them to every command.",
      "Review which step should receive caller arguments.",
    );
  }
  if (commands.some((step) => typeof step.cmd === "string" && POSITIONAL_PARAMETER.test(step.cmd))) {
    report(
      "needs-review",
      [...path, "cmd"],
      "This command reads positional parameters. Lando 4 passes caller input from $1 on, declared flags first as --name=value, so positions can differ from Lando 3.",
      "Check each positional reference against the task's input before relying on it.",
    );
  }

  const dir = lowerText(entry.dir, [...path, "dir"], report);
  if (typeof dir === "string") task.dir = dir;
  const env = entry.env === undefined ? undefined : lowerEnv(entry.env, [...path, "env"], report);
  if (env !== undefined) task.env = env;
  const user = lowerText(entry.user, [...path, "user"], report);
  if (typeof user === "string") {
    task.user = user;
    report("rewritten", [...path, "user"], "user moved to the task user.", "Review the task user.");
  }
  if (typeof entry.disabled === "boolean") {
    task.disabled = entry.disabled;
    report("rewritten", [...path, "disabled"], "disabled moved to the task.", "Review the disabled task.");
  }
  const flags = lowerFlags(options, [...path, "options"], report, serviceFlag);
  if (flags !== undefined) task.flags = flags;
  const args = lowerPositionals(positionalTokens, entry.positionals, path, report);
  if (args === "invalid") return undefined;
  if (args !== undefined) task.args = args;
  for (const [key, [message, remediation]] of Object.entries(DROPPED_TASK_KEYS)) {
    if (Object.hasOwn(entry, key)) report("dropped", [...path, key], message, remediation);
  }
  return { task, facts: { service } };
};

export const lowerTooling = (value: unknown, report: Report): LoweredTooling => {
  const tooling: Record<string, V4Wire> = {};
  const tasks = new Map<string, LoweredTask>();
  if (!isPlainObject(value)) return { tooling, tasks };
  for (const [key, entry] of Object.entries(value)) {
    const path = ["tooling", key];
    const match = TASK_NAME.exec(key);
    const name = match?.[1];
    if (match === null || name === undefined || Object.hasOwn(tooling, name)) {
      report(
        "unsupported",
        path,
        `Tooling task ${key} does not name a single Lando 4 command.`,
        "Rename the task to one word, with positional arguments in brackets after it, before converting.",
      );
      continue;
    }
    if (isLegacyTagged(entry)) {
      report(
        "unsupported",
        path,
        "A tooling task must be an inline mapping; tagged references are not read.",
        "Inline the task mapping before converting.",
      );
      continue;
    }
    if (!isPlainObject(entry)) {
      tooling[name] = { disabled: true };
      tasks.set(name, { service: undefined });
      report(
        "rewritten",
        path,
        "Lando 3 removed a task whose value is not a mapping; it is now disabled: true.",
        "Delete the task instead if nothing else defines it.",
      );
      continue;
    }
    const lowered = lowerTask(name, match[2] ?? "", entry, path, report);
    if (lowered === undefined) continue;
    tooling[name] = lowered.task;
    tasks.set(name, lowered.facts);
  }
  return { tooling, tasks };
};
