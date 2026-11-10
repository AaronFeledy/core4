import type { NormalizedToolingTask, ToolingServiceRef } from "@lando/landofile/tooling-normalize";
import type { ToolingRunSummary, ToolingRunTarget } from "@lando/sdk/schema";

const runTarget = (service: ToolingServiceRef | undefined): ToolingRunTarget => {
  switch (service?.kind) {
    case undefined:
      return { kind: "primary" };
    case "service":
      return service.name.includes("{{") ? { kind: "dynamic" } : service;
    case "host":
    case "flag":
      return service;
    default:
      return service satisfies never;
  }
};

/**
 * The program of shell text that is one simple command: the first word after leading
 * `NAME=value` assignments. Quoted arguments are fine; anything that could run a second
 * command (an unquoted operator, command substitution, a line break) yields no program.
 */
const simpleCommandProgram = (cmd: string): string | undefined => {
  if (/[\r\n`]|\$\(/u.test(cmd)) return undefined;
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < cmd.length; index += 1) {
    const char = cmd.charAt(index);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') {
        word += char;
        index += 1;
      }
      word += cmd.charAt(index);
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      word += char;
    } else if (char === "\\" || /[|&;<>(){}[\]]/u.test(char)) return undefined;
    else if (/\s/u.test(char)) {
      if (word !== "") words.push(word);
      word = "";
    } else word += char;
  }
  if (quote !== undefined) return undefined;
  if (word !== "") words.push(word);
  return words.find((candidate) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(candidate));
};

export const toolingRunSummary = (task: NormalizedToolingTask): ToolingRunSummary | undefined => {
  if (task.steps.length === 0 || task.steps.length > 1000) return undefined;
  const targets: ToolingRunTarget[] = [];
  const seen = new Set<string>();
  for (const step of task.steps) {
    const target = runTarget(step.service);
    const key = JSON.stringify(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  if (targets.length > 32) return undefined;
  const step = task.steps.length === 1 ? task.steps[0] : undefined;
  let program: string | undefined;
  if (step !== undefined) {
    program = step.argv === undefined ? simpleCommandProgram(step.cmd) : step.argv[0];
    if (program !== undefined && !/^[A-Za-z0-9_./][A-Za-z0-9_.+/-]*$/u.test(program)) program = undefined;
  }
  return {
    kind: "commands",
    steps: task.steps.length,
    targets,
    ...(program !== undefined && program.length >= 1 && program.length <= 64 ? { program } : {}),
  };
};
