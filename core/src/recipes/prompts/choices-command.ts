/**
 * Dynamic prompt `choicesFrom:` execution seam.
 *
 * A `select`/`multiselect` recipe prompt can source its choices from a
 * canonical Lando command run in a sandboxed bootstrap that requires no
 * app. The command is re-invoked as a child process (mirroring the
 * `BunSelfSpawner` precedent) and its stdout is parsed per `parse:`.
 * The runner is injectable so the prompt runtime stays unit-testable
 * without spawning real processes.
 */
import type { RecipeChoicesFrom, RecipePromptChoice } from "@lando/sdk/schema";

export interface ChoicesCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ChoicesCommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export type ChoicesCommandRunner = (input: ChoicesCommandInput) => Promise<ChoicesCommandResult>;

export interface ChoicesCommandSpawnerOptions {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
}

export interface ChoicesCommandSpawner {
  readonly spawn: (options: ChoicesCommandSpawnerOptions) => Promise<ChoicesCommandResult>;
}

export const defaultChoicesCommandSpawner: ChoicesCommandSpawner = {
  spawn: async ({ cmd, cwd }) => {
    const proc = Bun.spawn({
      cmd: [...cmd],
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  },
};

/**
 * Prefer Bun 1.4 `Bun.isStandaloneExecutable` when present. Returns
 * `undefined` when the property is missing so callers can fall back to
 * `$bunfs` / `argv[1]` matching.
 */
export const readStandaloneExecutable = (
  bun: { readonly isStandaloneExecutable?: unknown } = Bun,
): boolean | undefined =>
  typeof bun.isStandaloneExecutable === "boolean" ? bun.isStandaloneExecutable : undefined;

/**
 * Build the argv prefix that re-invokes the Lando CLI.
 *
 * Compiled / standalone binaries use `[execPath]` only. Source mode uses
 * `[execPath, argv[1]]`. When `standalone` is omitted, the Bun 1.4
 * `isStandaloneExecutable` property decides; if that property is missing,
 * `$bunfs` in `argv[1]` remains a defensive fallback. Compiled detection
 * does not require `$bunfs` once the API exists.
 *
 * Do not set `BUN_BE_BUN` here — this re-entry wants normal Lando dispatch,
 * not bun-self-runner mode.
 */
export interface LandoInvocationPrefixOptions {
  /**
   * When provided (including `undefined`), skip reading `Bun.isStandaloneExecutable`.
   * Pass `undefined` to exercise the `$bunfs` fallback.
   */
  readonly standalone?: boolean | undefined;
}

export const landoInvocationPrefix = (
  execPath: string,
  argv: ReadonlyArray<string>,
  options?: LandoInvocationPrefixOptions,
): ReadonlyArray<string> => {
  const standalone =
    options !== undefined && "standalone" in options ? options.standalone : readStandaloneExecutable();
  if (standalone === true) return [execPath];
  const entry = argv[1];
  if (standalone === false) {
    if (entry === undefined || entry === "") return [execPath];
    return [execPath, entry];
  }
  if (entry === undefined || entry === "" || entry.includes("$bunfs")) return [execPath];
  return [execPath, entry];
};

export interface DefaultChoicesCommandRunnerOptions {
  readonly spawner?: ChoicesCommandSpawner;
  readonly execPath?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly standalone?: boolean;
}

export const createDefaultChoicesCommandRunner = (
  options: DefaultChoicesCommandRunnerOptions = {},
): ChoicesCommandRunner => {
  const spawner = options.spawner ?? defaultChoicesCommandSpawner;
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const cwd = options.cwd ?? process.cwd();
  const prefix = landoInvocationPrefix(
    execPath,
    argv,
    options.standalone === undefined ? undefined : { standalone: options.standalone },
  );
  return ({ command, args }) => spawner.spawn({ cmd: [...prefix, command, ...args], cwd });
};

export type ChoicesParseFailureKind = "unparseable" | "empty";

export class ChoicesParseFailure extends Error {
  readonly kind: ChoicesParseFailureKind;
  constructor(kind: ChoicesParseFailureKind, message: string) {
    super(message);
    this.name = "ChoicesParseFailure";
    this.kind = kind;
  }
}

const isChoiceScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const toChoice = (value: unknown): RecipePromptChoice | undefined => {
  if (isChoiceScalar(value)) return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    const record = value as Record<string, unknown>;
    if (!isChoiceScalar(record.value)) return undefined;
    const choice: { value: string | number | boolean; label?: string; description?: string } = {
      value: record.value,
    };
    if (typeof record.label === "string") choice.label = record.label;
    if (typeof record.description === "string") choice.description = record.description;
    return choice;
  }
  return undefined;
};

const parseJsonChoices = (stdout: string): ReadonlyArray<RecipePromptChoice> => {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new ChoicesParseFailure("unparseable", "command output is not valid JSON");
  }
  if (!Array.isArray(data)) {
    throw new ChoicesParseFailure("unparseable", "command JSON output must be an array of choices");
  }
  const choices: RecipePromptChoice[] = [];
  for (const entry of data) {
    const choice = toChoice(entry);
    if (choice === undefined) {
      throw new ChoicesParseFailure(
        "unparseable",
        "command JSON output contains an entry that is not a choice value or {value,label?} object",
      );
    }
    choices.push(choice);
  }
  if (choices.length === 0) throw new ChoicesParseFailure("empty", "command returned no choices");
  return choices;
};

const parseLinesChoices = (stdout: string): ReadonlyArray<RecipePromptChoice> => {
  const choices = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (choices.length === 0) throw new ChoicesParseFailure("empty", "command returned no choices");
  return choices;
};

export const parseChoicesOutput = (
  stdout: string,
  parse: RecipeChoicesFrom["parse"],
): ReadonlyArray<RecipePromptChoice> =>
  parse === "json" ? parseJsonChoices(stdout) : parseLinesChoices(stdout);
