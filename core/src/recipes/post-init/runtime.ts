import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { NotImplementedError, RecipePostInitError } from "@lando/sdk/errors";
import type { RecipePostInitAction } from "@lando/sdk/schema";

import {
  BUN_BE_BUN_ENV,
  BUN_SELF_REENTRY_ENV,
  type BunSelfSpawner,
} from "../../cli/commands/bun-self-runner.ts";

export interface PostInitIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const createStdioPostInitIO = (): PostInitIO => ({
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
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
}

const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|credential|bearer|apikey|api[_-]?key|^authorization$|^auth(?:token|orization)?$/iu;

const SECRET_ENV_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|BEARER|APIKEY|API_KEY)[A-Z0-9_]*)=([^\s,;"'\]\}]+)/gu;

const REGISTRY_URL_PATTERN = /\/\/([^@\s/:]+):([^@\s/:]+)@/gu;

export const redactBunOutput = (text: string): string =>
  text
    .replace(SECRET_ENV_PATTERN, (_, name) => `${String(name)}=${REDACTED}`)
    .replace(REGISTRY_URL_PATTERN, `//$1:${REDACTED}@`);

const filteredChildEnv = (parentEnv: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (typeof v !== "string") continue;
    if (SECRET_KEY_PATTERN.test(k)) {
      env[k] = v;
      continue;
    }
    env[k] = v;
  }
  env[BUN_BE_BUN_ENV] = "1";
  env[BUN_SELF_REENTRY_ENV] = "1";
  return env;
};

const realpathOrUndefined = async (path: string): Promise<string | undefined> => {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
};

const isInside = (parent: string, candidate: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}${sep}`);

const resolveBunCwd = async (
  rawCwd: string | undefined,
  destination: string,
  recipe: string,
  index: number,
): Promise<string> => {
  const raw = typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : ".";

  if (raw.split(/[\\/]/u).some((segment) => segment === "..")) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun install): cwd "${raw}" must not contain ".." segments.`,
      recipe,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "install",
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
      message: `postInit[${index}] (bun install): cwd "${raw}" resolves outside the recipe destination (${resolvedDestination}).`,
      recipe,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "install",
      kind: "outside-destination",
      remediation:
        "Set `cwd:` to the recipe destination or a subdirectory of it. Symlinks that escape the destination are rejected.",
    });
  }

  return resolvedCwd;
};

const ensurePackageJson = async (cwd: string, recipe: string, index: number): Promise<void> => {
  const pkgPath = `${cwd}${sep}package.json`;
  const exists = await Bun.file(pkgPath).exists();
  if (exists) return;
  throw new RecipePostInitError({
    message: `postInit[${index}] (bun install): no package.json found at ${pkgPath}.`,
    recipe,
    actionIndex: index,
    actionType: "bun",
    actionVerb: "install",
    kind: "missing-package-json",
    remediation:
      "Author a recipe that writes package.json before the bun install action runs, or remove the action.",
  });
};

const runBunInstall = async (
  action: Extract<RecipePostInitAction, { type: "bun" }>,
  index: number,
  options: RunPostInitOptions,
): Promise<void> => {
  const spawner = options.spawner;
  if (spawner === undefined) {
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun install): no Bun spawner is wired in this build.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "install",
      kind: "exit",
      remediation:
        "Run `lando init` through the official CLI; the bundled binary wires Bun via BunSelfRunner automatically.",
    });
  }

  const cwd = await resolveBunCwd(action.cwd, options.destination, options.recipeId, index);
  await ensurePackageJson(cwd, options.recipeId, index);

  const execPath = options.execPath ?? process.execPath;
  const parentEnv = options.env ?? process.env;
  const childEnv = filteredChildEnv(parentEnv);

  const argv = ["install"];

  const result = await spawner.spawn({
    cmd: [execPath, ...argv],
    env: childEnv,
    cwd,
  });

  if (result.exitCode !== 0) {
    const remediation = [
      `\`bun install\` exited with code ${result.exitCode} in ${cwd}.`,
      "Network access is required to fetch packages; lifecycle scripts in dependencies run as the invoking user.",
      `Retry with: rm -rf ${cwd}${sep}node_modules && lando bun install (run from ${cwd}).`,
      "Generated files were NOT removed; inspect the destination and re-run when the cause is resolved.",
    ].join(" ");
    throw new RecipePostInitError({
      message: `postInit[${index}] (bun install) failed with exit code ${result.exitCode}.`,
      recipe: options.recipeId,
      actionIndex: index,
      actionType: "bun",
      actionVerb: "install",
      kind: "exit",
      remediation: redactBunOutput(remediation),
      exitCode: result.exitCode,
    });
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
    message: `postInit[${index}] (gitInit): post-init gitInit is deferred to the Beta release.`,
    commandId: "apps:init",
    specSection: "§8.8.8",
    remediation: "Run `git init` manually after `lando init` completes for now.",
  });
};

const rejectCommand = (index: number): never => {
  throw new NotImplementedError({
    message: `postInit[${index}] (command): post-init canonical command dispatch is deferred to the Beta release.`,
    commandId: "apps:init",
    specSection: "§8.8.8",
    remediation:
      "Use `message:` to instruct the user, or invoke the desired Lando command manually after `lando init`.",
  });
};

const rejectWhen = (index: number, action: RecipePostInitAction): never => {
  const verb = action.type === "bun" ? action.verb : undefined;
  throw new NotImplementedError({
    message: `postInit[${index}] (${action.type}${verb === undefined ? "" : `:${verb}`}): \`when:\` expressions are deferred to the Beta release.`,
    commandId: "apps:init",
    specSection: "§8.8.5",
    remediation:
      "Remove `when:` from the post-init action. Conditional execution returns in the Beta expression engine.",
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
        await runBunInstall(action, index, options);
        executed.push({ index, type: "bun", verb: action.verb });
        break;
      }
      case "gitInit": {
        rejectGitInit(index);
        break;
      }
      case "command": {
        rejectCommand(index);
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
