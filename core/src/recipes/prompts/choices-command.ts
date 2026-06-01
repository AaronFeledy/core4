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
 * Build the argv prefix that re-invokes the Lando CLI.
 *
 * Compiled `bun build --compile` binaries embed the entry under
 * `$bunfs`, so `process.execPath` IS the `lando` binary. In source mode
 * `process.execPath` is Bun and `argv[1]` is the CLI entry script.
 */
export const landoInvocationPrefix = (
  execPath: string,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const entry = argv[1];
  if (entry === undefined || entry === "" || entry.includes("$bunfs")) return [execPath];
  return [execPath, entry];
};

export interface DefaultChoicesCommandRunnerOptions {
  readonly spawner?: ChoicesCommandSpawner;
  readonly execPath?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly cwd?: string;
}

export const createDefaultChoicesCommandRunner = (
  options: DefaultChoicesCommandRunnerOptions = {},
): ChoicesCommandRunner => {
  const spawner = options.spawner ?? defaultChoicesCommandSpawner;
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const cwd = options.cwd ?? process.cwd();
  const prefix = landoInvocationPrefix(execPath, argv);
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
