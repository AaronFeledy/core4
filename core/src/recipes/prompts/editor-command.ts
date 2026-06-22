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
  | { readonly kind: "no-editor" };

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
 * `$EDITOR`. The variable may carry arguments (e.g. `code --wait`), so
 * it is split on whitespace into a command and trailing argv. Returns
 * `undefined` when neither variable is set to a non-empty value.
 */
export const resolveEditorCommand = (
  env: Readonly<Record<string, string | undefined>>,
): { readonly cmd: string; readonly args: ReadonlyArray<string> } | undefined => {
  const raw = (env.VISUAL ?? "").trim() === "" ? (env.EDITOR ?? "").trim() : (env.VISUAL ?? "").trim();
  if (raw === "") return undefined;
  const parts = raw.split(/\s+/).filter((part) => part !== "");
  const [cmd, ...args] = parts;
  if (cmd === undefined) return undefined;
  return { cmd, args };
};

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
      await spawner.spawn({ cmd: editor.cmd, args: [...editor.args, file], cwd });
      const edited = await readFile(file, "utf8");
      return { kind: "edited", content: edited };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
};
