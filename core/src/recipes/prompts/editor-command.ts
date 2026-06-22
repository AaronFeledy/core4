/**
 * `editor` prompt type execution seam.
 *
 * An `editor` prompt opens the author's `$VISUAL`/`$EDITOR` on a
 * temp-file buffer (seeded with the prompt default), waits for the
 * editor to exit, then reads the edited buffer back and applies the
 * prompt's `validate` (text) rules. The spawner is injectable so the
 * prompt runtime stays unit-testable without launching a real editor,
 * and the runner reports a `no-editor` outcome when neither variable is
 * configured so the runtime can fall back to plain `text` semantics.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EditorRunInput {
  /** Prompt name — used to build a readable temp-file name. */
  readonly name: string;
  /** Seed content written to the buffer before the editor opens. */
  readonly content: string;
  /** Working directory for the editor invocation. */
  readonly cwd: string;
}

export type EditorRunResult =
  | { readonly kind: "edited"; readonly content: string }
  | { readonly kind: "no-editor" }
  | { readonly kind: "failed"; readonly reason: string; readonly exitCode?: number };

/** Open a buffer in the configured editor and return the edited content. */
export type EditorRunner = (input: EditorRunInput) => Promise<EditorRunResult>;

export interface EditorSpawnerOptions {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

export interface EditorSpawner {
  readonly spawn: (options: EditorSpawnerOptions) => Promise<{ readonly exitCode: number }>;
}

/**
 * Default editor spawner: inherits the parent stdio so an interactive
 * editor (vim, nano, …) drives the terminal directly. Mirrors the
 * `ProcessRunner` spawn seam but keeps stdio attached to the TTY.
 */
export const defaultEditorSpawner: EditorSpawner = {
  spawn: async ({ cmd, args, cwd }) => {
    const proc = Bun.spawn({
      cmd: [cmd, ...args],
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    return { exitCode };
  },
};

/**
 * Resolve the editor command argv-precisely from `$VISUAL` then
 * `$EDITOR`. The variable may carry arguments (e.g. `code --wait`) and
 * shell-style quotes around command paths/args. Returns `undefined`
 * when neither variable is set to a non-empty value, or when the
 * configured command is not parseable.
 */
export const resolveEditorCommand = (
  env: Readonly<Record<string, string | undefined>>,
): { readonly cmd: string; readonly args: ReadonlyArray<string> } | undefined => {
  const raw = (env.VISUAL ?? "").trim() === "" ? (env.EDITOR ?? "").trim() : (env.VISUAL ?? "").trim();
  if (raw === "") return undefined;
  const parts = parseShellWords(raw);
  if (parts === undefined) return undefined;
  const [cmd, ...args] = parts;
  if (cmd === undefined) return undefined;
  return { cmd, args };
};

const parseShellWords = (raw: string): ReadonlyArray<string> | undefined => {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasToken = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      hasToken = true;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      hasToken = true;
      continue;
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
        hasToken = true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        words.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (escaped || quote !== undefined) return undefined;
  if (hasToken) words.push(current);
  return words;
};

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "_") || "prompt";

export interface DefaultEditorRunnerOptions {
  readonly spawner?: EditorSpawner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Override the temp-directory root (tests). */
  readonly tmpRoot?: string;
}

/**
 * Build the production editor runner. Resolves `$VISUAL`/`$EDITOR`,
 * writes a temp-file buffer, spawns the editor through the (injectable)
 * spawner, reads the edited buffer back, and always removes the temp
 * file. Reports `no-editor` when no editor is configured.
 */
export const createDefaultEditorRunner = (options: DefaultEditorRunnerOptions = {}): EditorRunner => {
  const spawner = options.spawner ?? defaultEditorSpawner;
  const env = options.env ?? process.env;
  return async ({ name, content, cwd }) => {
    const editor = resolveEditorCommand(env);
    if (editor === undefined) return { kind: "no-editor" };
    const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "lando-editor-"));
    const file = join(dir, `${sanitizeName(name)}.txt`);
    await writeFile(file, content, "utf8");
    try {
      let result: Awaited<ReturnType<EditorSpawner["spawn"]>>;
      try {
        result = await spawner.spawn({ cmd: editor.cmd, args: [...editor.args, file], cwd });
      } catch (cause) {
        return { kind: "failed", reason: `editor failed to run: ${describeCause(cause)}` };
      }
      if (result.exitCode !== 0) {
        return {
          kind: "failed",
          reason: `editor exited with code ${String(result.exitCode)}`,
          exitCode: result.exitCode,
        };
      }
      const edited = await readFile(file, "utf8");
      return { kind: "edited", content: edited };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
};
