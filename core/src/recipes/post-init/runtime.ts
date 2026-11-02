import { sep } from "node:path";

import { createStandaloneRedactor } from "@lando/redaction/service";
import { NotImplementedError, RecipePostInitError } from "@lando/sdk/errors";
import type { RecipePostInitAction } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";

import { type ChoicesCommandRunner, createDefaultChoicesCommandRunner } from "../prompts/choices-command";
import { defaultRunWarning, evaluateRunPermission, runNotAllowedError } from "../run-allowlist";
import { shouldRunPostInitAction } from "./authorization";
import { resolveCreateTemplate } from "./create-template.ts";
import { ensurePackageJson, resolveBunCwd, resolveCreateDest, resolveScriptPath } from "./paths";

export interface PostInitIO {
  readonly out: (line: string) => void | Promise<void>;
  readonly err: (line: string) => void | Promise<void>;
}

export interface PostInitExecutedAction {
  readonly index: number;
  readonly type: string;
  readonly verb?: string;
  readonly skipped?: boolean;
}

export interface PostInitOutcome {
  readonly executed: ReadonlyArray<PostInitExecutedAction>;
}

export interface RunPostInitOptions {
  readonly actions: ReadonlyArray<RecipePostInitAction>;
  readonly destination: string;
  readonly recipeId: string;
  readonly appName: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly io?: PostInitIO;
  readonly runBun: (request: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly execPath?: string;
  }) => Promise<{ readonly exitCode: number }>;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly runs?: ReadonlyArray<string>;
  readonly commandRunner?: ChoicesCommandRunner;
  readonly recipeRoot?: string;
  readonly redact?: (text: string) => string;
}

type ResolvedPostInitOptions = RunPostInitOptions & {
  readonly redact: (text: string) => string;
  readonly env: NodeJS.ProcessEnv;
};

/** Env-aware pattern/exact redactor for post-init when the caller did not inject one. */
const fallbackPostInitRedactor = (sourceEnv: Readonly<Record<string, string | undefined>>): Redactor =>
  createStandaloneRedactor("secrets", { sourceEnv: { ...sourceEnv } });

export const redactBunOutput = (
  text: string,
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
): string => fallbackPostInitRedactor(sourceEnv).redactString(text);

const spawnBun = async (
  argv: ReadonlyArray<string>,
  cwd: string,
  execution: { readonly index: number; readonly verb: string; readonly options: ResolvedPostInitOptions },
): Promise<void> => {
  const { index, verb, options } = execution;
  const result = await options.runBun({
    argv,
    cwd,
    env: options.env,
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
  });

  if (result.exitCode !== 0) {
    const detail =
      verb === "install"
        ? `Network access is required to fetch packages; lifecycle scripts in dependencies run as the invoking user. Retry with: rm -rf ${cwd}${sep}node_modules && lando bun install (run from ${cwd}). Generated files were NOT removed; inspect the destination and re-run when the cause is resolved.`
        : "Generated files were NOT removed; inspect the destination and re-run when the cause is resolved.";
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun ${verb}) failed with exit code ${result.exitCode}.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: verb,
      kind: "exit",
      remediation: options.redact(`\`bun ${verb}\` exited with code ${result.exitCode} in ${cwd}. ${detail}`),
      exitCode: result.exitCode,
    });
  }
};

const ADD_CATEGORY_FLAGS = [
  { key: "dependencies", flag: undefined },
  { key: "devDependencies", flag: "--dev" },
  { key: "peerDependencies", flag: "--peer" },
  { key: "optionalDependencies", flag: "--optional" },
] as const;

const runBun = async (
  action: Extract<RecipePostInitAction, { type: "bun" }>,
  index: number,
  options: ResolvedPostInitOptions,
): Promise<void> => {
  const execution = { index, verb: action.verb, options };
  const cwd = await resolveBunCwd(action, execution);

  switch (action.verb) {
    case "install": {
      await ensurePackageJson(cwd, action.verb, execution);
      await spawnBun(["install"], cwd, execution);
      return;
    }
    case "add": {
      for (const { key, flag } of ADD_CATEGORY_FLAGS) {
        const packages = action[key] ?? [];
        if (packages.length === 0) continue;
        const argv = flag === undefined ? ["add", ...packages] : ["add", flag, ...packages];
        await spawnBun(argv, cwd, execution);
      }
      return;
    }
    case "create": {
      const template = resolveCreateTemplate(action.template, index, options);
      const dest =
        action.dest === undefined ? undefined : await resolveCreateDest(action.dest, cwd, execution);
      const argv = dest === undefined ? ["create", template] : ["create", template, dest];
      await spawnBun(argv, cwd, execution);
      return;
    }
    case "run": {
      await ensurePackageJson(cwd, action.verb, execution);
      await spawnBun(["run", action.script, ...(action.args ?? [])], cwd, execution);
      return;
    }
    case "script": {
      const scriptPath = await resolveScriptPath(action.script, execution);
      await spawnBun(["run", scriptPath, ...(action.args ?? [])], cwd, execution);
      return;
    }
    case "x": {
      const spec = action.spec.trim();
      if (spec === "" || spec.startsWith("-")) {
        throw new RecipePostInitError({
          message: `postInit[${index}] (bun x): spec "${action.spec}" is invalid; it must not be empty or begin with "-".`,
          recipe: options.recipeId,
          actionIndex: index,
          actionType: "bun",
          actionVerb: "x",
          kind: "invalid-argv",
          remediation: "Set `spec:` to a package spec (e.g. `prettier`), not empty or a flag.",
        });
      }
      const permission = evaluateRunPermission(options.runs, spec);
      if (permission.kind === "denied") {
        throw runNotAllowedError(spec, permission.allowlist, options.recipeId);
      }
      if (permission.kind === "warn") {
        await options.io?.err(defaultRunWarning(spec, permission.allowlist));
      }
      await spawnBun(["x", spec, ...(action.argv ?? [])], cwd, execution);
      return;
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }
};

const runMessage = async (
  action: Extract<RecipePostInitAction, { type: "message" }>,
  options: RunPostInitOptions,
): Promise<void> => {
  await options.io?.out(action.text);
};

const rejectGitInit = (index: number): never => {
  throw new NotImplementedError({
    message: `postInit[${index}] (gitInit): post-init gitInit is not implemented.`,
    commandId: "apps:init",
    remediation: "Run `git init` manually after `lando init` completes for now.",
  });
};

const runCommand = async (
  action: Extract<RecipePostInitAction, { type: "command" }>,
  index: number,
  options: ResolvedPostInitOptions,
): Promise<void> => {
  const runner = options.commandRunner ?? createDefaultChoicesCommandRunner({ cwd: options.destination });
  const result = await runner({ command: action.cmd, args: action.args ?? [] });

  if (result.exitCode !== 0) {
    const redact = options.redact;
    const stderr = redact(result.stderr.trim());
    const stdout = redact(result.stdout.trim());
    const details = [stderr, stdout].filter((line) => line !== "").join(" ");
    throw new RecipePostInitError({
      message: `postInit[${index}] (command ${action.cmd}) failed with exit code ${result.exitCode}.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "command",
      kind: "exit",
      remediation: redact(
        `Command \`${action.cmd}\` exited with code ${result.exitCode}.${details === "" ? "" : ` Output: ${details}`} Fix the command or remove it from the recipe postInit action.`,
      ),
      exitCode: result.exitCode,
    });
  }
};

export const runPostInit = async (options: RunPostInitOptions): Promise<PostInitOutcome> => {
  const executed: PostInitExecutedAction[] = [];
  const sourceEnv = { ...(options.env ?? process.env) };
  const resolved: ResolvedPostInitOptions = {
    ...options,
    env: sourceEnv,
    redact: options.redact ?? fallbackPostInitRedactor(sourceEnv).redactString,
  };
  const selected = resolved.actions.map((action, index) => shouldRunPostInitAction(action, resolved, index));

  for (const [index, action] of resolved.actions.entries()) {
    if (!selected[index]) {
      executed.push({ index, type: action.type, skipped: true });
      continue;
    }

    switch (action.type) {
      case "message": {
        await runMessage(action, resolved);
        executed.push({ index, type: "message" });
        break;
      }
      case "bun": {
        await runBun(action, index, resolved);
        executed.push({ index, type: "bun", verb: action.verb });
        break;
      }
      case "gitInit": {
        rejectGitInit(index);
        break;
      }
      case "command": {
        await runCommand(action, index, resolved);
        executed.push({ index, type: "command" });
        break;
      }
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
        break;
      }
    }
  }

  return { executed };
};
