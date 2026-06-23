import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { NotImplementedError, RecipePostInitError } from "@lando/sdk/errors";
import type { RecipePostInitAction } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import {
  type BunSelfSpawner,
  childEnv as buildChildEnv,
  defaultBunSelfSpawner,
} from "../../cli/commands/bun-self-runner.ts";
import { type ChoicesCommandRunner, createDefaultChoicesCommandRunner } from "../prompts/choices-command.ts";
import {
  createRecipeRunContext,
  defaultRunWarning,
  evaluateRunPermission,
  runNotAllowedError,
} from "../run-allowlist.ts";

export interface PostInitIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const createStdioPostInitIO = (
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): PostInitIO => ({
  out: (line) => {
    stdout.write(`${line}\n`);
  },
  err: (line) => {
    stderr.write(`${line}\n`);
  },
});

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
  readonly spawner?: BunSelfSpawner;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly runs?: ReadonlyArray<string>;
  readonly commandRunner?: ChoicesCommandRunner;
  readonly recipeRoot?: string;
}

const secretsRedactor = createRedactor("secrets");

export const redactBunOutput = (text: string): string => secretsRedactor.redactString(text);

const realpathOrUndefined = async (path: string): Promise<string | undefined> => {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
};

// Security: a `bun create` dest leaf does not exist yet, so realpath(target)
// fails; falling back to the lexical path would skip symlink resolution of the
// existing parents and let a recipe-shipped symlink ancestor escape the
// destination. Realpath the nearest EXISTING parent to close that gap.
const nearestExistingRealpath = async (target: string): Promise<string> => {
  let current = target;
  for (;;) {
    const resolved = await realpathOrUndefined(current);
    if (resolved !== undefined) return resolved;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
};

const isInside = (parent: string, candidate: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}${sep}`);

const resolveBunCwd = async (
  rawCwd: string | undefined,
  destination: string,
  recipe: string,
  index: number,
  verb: string,
): Promise<string> => {
  const raw = typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : ".";

  if (raw.split(/[\\/]/u).some((segment) => segment === "..")) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun ${verb}): cwd "${raw}" must not contain ".." segments.`,
      recipe,
      actionIndex: index,
      actionType: "bun",
      actionVerb: verb,
      kind: "outside-destination",
      remediation:
        "Set `cwd:` to the recipe destination or a subdirectory of it. Path traversal via `..` is rejected.",
    });
  }

  const initial = isAbsolute(raw) ? raw : resolve(destination, raw);

  const resolvedDestination = (await realpathOrUndefined(destination)) ?? destination;
  const resolvedCwd = (await realpathOrUndefined(initial)) ?? initial;

  if (!isInside(resolvedDestination, resolvedCwd)) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun ${verb}): cwd "${raw}" resolves outside the recipe destination (${resolvedDestination}).`,
      recipe,
      actionIndex: index,
      actionType: "bun",
      actionVerb: verb,
      kind: "outside-destination",
      remediation:
        "Set `cwd:` to the recipe destination or a subdirectory of it. Symlinks that escape the destination are rejected.",
    });
  }

  return resolvedCwd;
};

const ensurePackageJson = async (cwd: string, recipe: string, index: number, verb: string): Promise<void> => {
  const pkgPath = `${cwd}${sep}package.json`;
  const exists = await Bun.file(pkgPath).exists();
  if (exists) return;
  throw new RecipePostInitError({
    message: `postInit[${index}] (bun ${verb}): no package.json found at ${pkgPath}.`,
    recipe,
    actionIndex: index,
    actionType: "bun",
    actionVerb: verb,
    kind: "missing-package-json",
    remediation: `Author a recipe that writes package.json before the bun ${verb} action runs, or remove the action.`,
  });
};

const spawnBun = async (
  argv: ReadonlyArray<string>,
  cwd: string,
  index: number,
  verb: string,
  options: RunPostInitOptions,
): Promise<void> => {
  const spawner = options.spawner ?? defaultBunSelfSpawner;
  const execPath = options.execPath ?? process.execPath;
  const childEnv = buildChildEnv(options.env ?? process.env);

  const result = await spawner.spawn({ cmd: [execPath, ...argv], env: childEnv, cwd });

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
      remediation: redactBunOutput(
        `\`bun ${verb}\` exited with code ${result.exitCode} in ${cwd}. ${detail}`,
      ),
      exitCode: result.exitCode,
    });
  }
};

const ANSWER_REFERENCE_PATTERN = /\$\{answers\.([A-Za-z0-9_-]+)\}/gu;

const substituteAnswers = (
  template: string,
  index: number,
  verb: string,
  options: RunPostInitOptions,
): string =>
  template.replace(ANSWER_REFERENCE_PATTERN, (_match, name: string) => {
    const value = options.answers[name];
    if (value === undefined || value === null || typeof value === "object") {
      throw new RecipePostInitError({
        message: `postInit[${index}] (bun ${verb}): template references unknown answer "${name}".`,
        recipe: options.recipeId,
        actionIndex: index,
        actionType: "bun",
        actionVerb: verb,
        kind: "invalid-argv",
        remediation: `Declare a prompt named "${name}" (or pass --answer ${name}=<value>) before the bun ${verb} action runs.`,
      });
    }
    return String(value);
  });

const resolveCreateDest = async (
  rawDest: string,
  destination: string,
  cwd: string,
  index: number,
  options: RunPostInitOptions,
): Promise<string> => {
  if (rawDest.split(/[\\/]/u).some((segment) => segment === "..")) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun create): dest "${rawDest}" must not contain ".." segments.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "create",
      kind: "outside-destination",
      remediation:
        "Set `dest:` to a path inside the recipe destination. Path traversal via `..` is rejected.",
    });
  }
  // Resolve `dest` against the execution `cwd` (where `bun create` actually
  // writes it), then verify the realpathed nearest existing parent stays inside
  // the recipe destination. Returning the absolute resolved path keeps the
  // validated path and the spawned argv in lockstep.
  const resolvedDest = isAbsolute(rawDest) ? rawDest : resolve(cwd, rawDest);
  const resolvedDestination = (await realpathOrUndefined(destination)) ?? destination;
  const anchor = await nearestExistingRealpath(resolvedDest);
  if (!isInside(resolvedDestination, anchor)) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun create): dest "${rawDest}" resolves outside the recipe destination (${resolvedDestination}).`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "create",
      kind: "outside-destination",
      remediation:
        "Set `dest:` to a path inside the recipe destination. Absolute paths and symlinks that escape it are rejected.",
    });
  }
  return resolvedDest;
};

const resolveScriptPath = async (
  rawScript: string,
  index: number,
  options: RunPostInitOptions,
): Promise<string> => {
  const recipeRoot = options.recipeRoot;
  if (recipeRoot === undefined) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun script): no recipe source tree is available to resolve "${rawScript}".`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "script",
      kind: "invalid-argv",
      remediation:
        "The `script` verb requires a recipe with an on-disk source tree (`templates/` or `assets/`); bundled in-binary recipes cannot use it.",
    });
  }
  if (rawScript.split(/[\\/]/u).some((segment) => segment === "..")) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun script): script "${rawScript}" must not contain ".." segments.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "script",
      kind: "outside-recipe",
      remediation: "Set `script:` to a path under the recipe's `templates/` or `assets/` tree.",
    });
  }
  const initial = isAbsolute(rawScript) ? rawScript : resolve(recipeRoot, rawScript);
  const resolvedRoot = (await realpathOrUndefined(recipeRoot)) ?? recipeRoot;
  const resolvedScript = await realpathOrUndefined(initial);
  if (resolvedScript === undefined) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun script): script file "${rawScript}" was not found under the recipe source tree.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "script",
      kind: "invalid-argv",
      remediation:
        "Ship the script under the recipe's `templates/` or `assets/` tree, or fix the `script:` path.",
    });
  }
  if (!isInside(resolvedRoot, resolvedScript)) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun script): script "${rawScript}" resolves outside the recipe source tree (${resolvedRoot}).`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "script",
      kind: "outside-recipe",
      remediation:
        "Set `script:` to a path inside the recipe's `templates/` or `assets/` tree. Symlinks that escape it are rejected.",
    });
  }
  return resolvedScript;
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
  options: RunPostInitOptions,
): Promise<void> => {
  const cwd = await resolveBunCwd(action.cwd, options.destination, options.recipeId, index, action.verb);

  switch (action.verb) {
    case "install": {
      await ensurePackageJson(cwd, options.recipeId, index, action.verb);
      await spawnBun(["install"], cwd, index, action.verb, options);
      return;
    }
    case "add": {
      for (const { key, flag } of ADD_CATEGORY_FLAGS) {
        const packages = action[key] ?? [];
        if (packages.length === 0) continue;
        const argv = flag === undefined ? ["add", ...packages] : ["add", flag, ...packages];
        await spawnBun(argv, cwd, index, action.verb, options);
      }
      return;
    }
    case "create": {
      const template = substituteAnswers(action.template, index, action.verb, options);
      const trimmedTemplate = template.trim();
      if (trimmedTemplate === "" || trimmedTemplate.startsWith("-")) {
        throw new RecipePostInitError({
          message: `postInit[${index}] (bun create): template "${template}" is invalid; it must not be empty or begin with "-".`,
          recipe: options.recipeId,
          actionIndex: index,
          actionType: "bun",
          actionVerb: "create",
          kind: "invalid-argv",
          remediation:
            "Ensure the `template:` value (after answer substitution) is a package or template name, not empty or a flag.",
        });
      }
      const dest =
        action.dest === undefined
          ? undefined
          : await resolveCreateDest(action.dest, options.destination, cwd, index, options);
      const argv = dest === undefined ? ["create", template] : ["create", template, dest];
      await spawnBun(argv, cwd, index, action.verb, options);
      return;
    }
    case "run": {
      await ensurePackageJson(cwd, options.recipeId, index, action.verb);
      await spawnBun(["run", action.script, ...(action.args ?? [])], cwd, index, action.verb, options);
      return;
    }
    case "script": {
      const scriptPath = await resolveScriptPath(action.script, index, options);
      await spawnBun(["run", scriptPath, ...(action.args ?? [])], cwd, index, action.verb, options);
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
        const io = options.io ?? createStdioPostInitIO();
        io.err(defaultRunWarning(spec, permission.allowlist));
      }
      await spawnBun(["x", spec, ...(action.argv ?? [])], cwd, index, action.verb, options);
      return;
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }
};

const runMessage = (
  action: Extract<RecipePostInitAction, { type: "message" }>,
  options: RunPostInitOptions,
): void => {
  const io = options.io ?? createStdioPostInitIO();
  io.out(action.text);
};

const rejectGitInit = (index: number): never => {
  throw new NotImplementedError({
    message: `postInit[${index}] (gitInit): post-init gitInit is deferred to the release.`,
    commandId: "apps:init",
    remediation: "Run `git init` manually after `lando init` completes for now.",
  });
};

const runCommand = async (
  action: Extract<RecipePostInitAction, { type: "command" }>,
  index: number,
  options: RunPostInitOptions,
): Promise<void> => {
  const io = options.io ?? createStdioPostInitIO();
  const ctx = createRecipeRunContext({
    runs: options.runs,
    runner: options.commandRunner ?? createDefaultChoicesCommandRunner(),
    onWarn: (message) => io.err(message),
    recipe: options.recipeId,
  });
  const result = await ctx.run(action.cmd, action.args);

  if (result.exitCode !== 0) {
    const stderr = redactBunOutput(result.stderr.trim());
    const stdout = redactBunOutput(result.stdout.trim());
    const details = [stderr, stdout].filter((line) => line !== "").join(" ");
    throw new RecipePostInitError({
      message: `postInit[${index}] (command ${action.cmd}) failed with exit code ${result.exitCode}.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "command",
      kind: "exit",
      remediation: redactBunOutput(
        `Command \`${action.cmd}\` exited with code ${result.exitCode}.${details === "" ? "" : ` Output: ${details}`} Fix the command or remove it from the recipe postInit action.`,
      ),
      exitCode: result.exitCode,
    });
  }
};

const rejectWhen = (index: number, action: RecipePostInitAction): never => {
  const verb = action.type === "bun" ? action.verb : undefined;
  throw new NotImplementedError({
    message: `postInit[${index}] (${action.type}${verb === undefined ? "" : `:${verb}`}): \`when:\` expressions are deferred to the release.`,
    commandId: "apps:init",
    remediation:
      "Remove `when:` from the post-init action. Conditional execution returns in the expression engine.",
  });
};

export const runPostInit = async (options: RunPostInitOptions): Promise<PostInitOutcome> => {
  const executed: PostInitExecutedAction[] = [];

  for (const [index, action] of options.actions.entries()) {
    if ("when" in action && typeof action.when === "string" && action.when.trim() !== "") {
      rejectWhen(index, action);
    }

    switch (action.type) {
      case "message": {
        runMessage(action, options);
        executed.push({ index, type: "message" });
        break;
      }
      case "bun": {
        await runBun(action, index, options);
        executed.push({ index, type: "bun", verb: action.verb });
        break;
      }
      case "gitInit": {
        rejectGitInit(index);
        break;
      }
      case "command": {
        await runCommand(action, index, options);
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
