import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { RecipeMissingAnswerError, RecipePromptValidationError } from "@lando/sdk/errors";
import { RecipePrompt } from "@lando/sdk/schema";

import {
  type EditorRunner,
  collectPrompts,
  createBufferedPromptIO,
  createDefaultEditorRunner,
  parseAnswerFlags,
  resolveEditorCommand,
} from "../../../src/recipes/prompts/index.ts";

const prompt = (input: unknown): typeof RecipePrompt.Type => Schema.decodeUnknownSync(RecipePrompt)(input);

describe("collectPrompts — text", () => {
  test("interactive: reads a single line and trims trailing newline", async () => {
    const io = createBufferedPromptIO({ inputs: ["my-app"] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "name", type: "text", message: "App name" })],
      io,
    });
    expect(answers.name).toBe("my-app");
    expect(io.stdout()).toContain("App name");
  });

  test("interactive: re-prompts on pattern validation failure (recoverable)", async () => {
    const io = createBufferedPromptIO({
      inputs: ["Bad Name", "good-name"],
    });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "name",
          type: "text",
          message: "App name",
          validate: {
            pattern: "^[a-z][a-z0-9-]*$",
            message: "App name must be lowercase kebab-case.",
          },
        }),
      ],
      io,
    });
    expect(answers.name).toBe("good-name");
    expect(io.stderr()).toContain("Invalid value: App name must be lowercase kebab-case.");
  });

  test("non-interactive: missing answer raises RecipeMissingAnswerError", async () => {
    const promise = collectPrompts({
      prompts: [prompt({ name: "name", type: "text", message: "App name" })],
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipeMissingAnswerError);
    await expect(promise).rejects.toMatchObject({ _tag: "RecipeMissingAnswerError", promptName: "name" });
  });

  test("non-interactive: --answer satisfies the prompt and is validated", async () => {
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "name",
          type: "text",
          message: "App name",
          validate: { pattern: "^[a-z]+$" },
        }),
      ],
      answers: { name: "mvp" },
      nonInteractive: true,
    });
    expect(answers.name).toBe("mvp");
  });

  test("non-interactive: invalid --answer raises RecipePromptValidationError", async () => {
    const promise = collectPrompts({
      prompts: [
        prompt({
          name: "name",
          type: "text",
          message: "App name",
          validate: { pattern: "^[a-z]+$", message: "alpha only" },
        }),
      ],
      answers: { name: "BAD" },
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipePromptValidationError);
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipePromptValidationError",
      promptName: "name",
      promptType: "text",
    });
  });
});

describe("collectPrompts — select", () => {
  test("interactive: accepts a value", async () => {
    const io = createBufferedPromptIO({ inputs: ["postgres"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "db",
          type: "select",
          message: "Pick a database",
          choices: ["mysql", "postgres", "sqlite"],
        }),
      ],
      io,
    });
    expect(answers.db).toBe("postgres");
    expect(io.stdout()).toContain("1) mysql");
    expect(io.stdout()).toContain("2) postgres");
    expect(io.stdout()).toContain("3) sqlite");
  });

  test("interactive: accepts a 1-based index", async () => {
    const io = createBufferedPromptIO({ inputs: ["2"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "db",
          type: "select",
          message: "Pick a database",
          choices: ["mysql", "postgres", "sqlite"],
        }),
      ],
      io,
    });
    expect(answers.db).toBe("postgres");
  });

  test("interactive: re-prompts on an out-of-range index (recoverable)", async () => {
    const io = createBufferedPromptIO({ inputs: ["99", "mysql"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "db",
          type: "select",
          message: "Pick a database",
          choices: ["mysql", "postgres"],
        }),
      ],
      io,
    });
    expect(answers.db).toBe("mysql");
    expect(io.stderr()).toContain("Invalid value: selection index 99 is out of range");
  });
});

describe("collectPrompts — multiselect", () => {
  test("interactive: parses comma-separated values and deduplicates", async () => {
    const io = createBufferedPromptIO({ inputs: ["redis, redis, search"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search", "queue"],
        }),
      ],
      io,
    });
    expect(answers.addons).toEqual(["redis", "search"]);
  });

  test("interactive: empty answer yields an empty array", async () => {
    const io = createBufferedPromptIO({ inputs: [""] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search"],
        }),
      ],
      io,
    });
    expect(answers.addons).toEqual([]);
  });

  test("interactive: rejects an unknown token and re-prompts", async () => {
    const io = createBufferedPromptIO({ inputs: ["bogus", "redis"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search"],
        }),
      ],
      io,
    });
    expect(answers.addons).toEqual(["redis"]);
    expect(io.stderr()).toContain('Invalid value: no choice matches "bogus"');
  });
});

describe("collectPrompts — confirm", () => {
  test("interactive: accepts 'y' as true", async () => {
    const io = createBufferedPromptIO({ inputs: ["y"] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "ssl", type: "confirm", message: "Enable SSL?" })],
      io,
    });
    expect(answers.ssl).toBe(true);
  });

  test("interactive: accepts blank with a default", async () => {
    const io = createBufferedPromptIO({ inputs: [""] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "ssl", type: "confirm", message: "Enable SSL?", default: true })],
      io,
    });
    expect(answers.ssl).toBe(true);
  });

  test("interactive: rejects garbage and re-prompts", async () => {
    const io = createBufferedPromptIO({ inputs: ["maybe", "no"] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "ssl", type: "confirm", message: "Enable SSL?" })],
      io,
    });
    expect(answers.ssl).toBe(false);
    expect(io.stderr()).toContain('Invalid value: expected yes/no, got "maybe"');
  });
});

describe("collectPrompts — number", () => {
  test("interactive: parses an integer", async () => {
    const io = createBufferedPromptIO({ inputs: ["8080"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "port",
          type: "number",
          message: "Port",
          validate: { min: 1, max: 65535 },
        }),
      ],
      io,
    });
    expect(answers.port).toBe(8080);
  });

  test("interactive: re-prompts when below min", async () => {
    const io = createBufferedPromptIO({ inputs: ["0", "80"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "port",
          type: "number",
          message: "Port",
          validate: { min: 1, max: 65535 },
        }),
      ],
      io,
    });
    expect(answers.port).toBe(80);
    expect(io.stderr()).toContain("Invalid value: value must be >= 1");
  });

  test("non-interactive: non-numeric --answer raises RecipePromptValidationError", async () => {
    const promise = collectPrompts({
      prompts: [prompt({ name: "port", type: "number", message: "Port", validate: { min: 1, max: 65535 } })],
      answers: { port: "abc" },
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipePromptValidationError);
  });
});

describe("collectPrompts — secret", () => {
  test("interactive: returns the input and never echoes it to the transcript", async () => {
    const secret = "hunter2!s3cret";
    const io = createBufferedPromptIO({ inputs: [secret] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "db_password", type: "secret", message: "Database password" })],
      io,
    });
    expect(answers.db_password).toBe(secret);
    expect(io.stdout()).not.toContain(secret);
    expect(io.stderr()).not.toContain(secret);
  });

  test("interactive: re-prompts on pattern validation failure without echoing the rejected value", async () => {
    const bad = "tiny";
    const good = "long-enough-secret";
    const io = createBufferedPromptIO({ inputs: [bad, good] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "db_password",
          type: "secret",
          message: "Database password",
          validate: { pattern: "^.{8,}$", message: "must be at least 8 characters" },
        }),
      ],
      io,
    });
    expect(answers.db_password).toBe(good);
    expect(io.stdout()).not.toContain(bad);
    expect(io.stdout()).not.toContain(good);
    expect(io.stderr()).not.toContain(bad);
    expect(io.stderr()).not.toContain(good);
    expect(io.stderr()).toContain("must be at least 8 characters");
  });

  test("non-interactive: missing answer raises RecipeMissingAnswerError without echoing values", async () => {
    const promise = collectPrompts({
      prompts: [prompt({ name: "db_password", type: "secret", message: "Database password" })],
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipeMissingAnswerError);
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipeMissingAnswerError",
      promptName: "db_password",
    });
  });
});

describe("collectPrompts — path", () => {
  test("interactive: accepts a relative path resolved against cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-prompts-"));
    try {
      const file = join(dir, "marker.txt");
      await writeFile(file, "ok");
      const io = createBufferedPromptIO({ inputs: ["marker.txt"] });
      const answers = await collectPrompts({
        prompts: [
          prompt({
            name: "marker",
            type: "path",
            message: "Marker path",
            validate: { exists: true },
          }),
        ],
        cwd: dir,
        io,
      });
      expect(answers.marker).toBe(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("interactive: re-prompts when validate.exists fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-prompts-"));
    try {
      const file = join(dir, "marker.txt");
      await writeFile(file, "ok");
      const io = createBufferedPromptIO({ inputs: ["missing.txt", "marker.txt"] });
      const answers = await collectPrompts({
        prompts: [
          prompt({
            name: "marker",
            type: "path",
            message: "Marker path",
            validate: { exists: true },
          }),
        ],
        cwd: dir,
        io,
      });
      expect(answers.marker).toBe(file);
      expect(io.stderr()).toContain("Invalid value: path does not exist");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("collectPrompts — select with numeric choice values", () => {
  test("interactive: literal numeric value match wins over index lookup", async () => {
    const io = createBufferedPromptIO({ inputs: ["443"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "port",
          type: "select",
          message: "Pick a port",
          choices: [80, 443, 8080],
        }),
      ],
      io,
    });
    expect(answers.port).toBe(443);
  });

  test("interactive: index fallback still works when no literal match exists", async () => {
    const io = createBufferedPromptIO({ inputs: ["2"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "port",
          type: "select",
          message: "Pick a port",
          choices: [80, 443, 8080],
        }),
      ],
      io,
    });
    expect(answers.port).toBe(443);
  });
});

describe("collectPrompts — multiselect validate.min/max enforcement", () => {
  test("non-interactive: empty answer rejected when validate.min: 1", async () => {
    const promise = collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search"],
          validate: { min: 1 },
        }),
      ],
      answers: { addons: "" },
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipePromptValidationError);
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipePromptValidationError",
      promptType: "multiselect",
    });
  });

  test("non-interactive: validate.max rejects oversized selection", async () => {
    const promise = collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["a", "b", "c"],
          validate: { max: 2 },
        }),
      ],
      answers: { addons: "a,b,c" },
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipePromptValidationError);
  });

  test("interactive: blank input re-prompts when validate.min: 1", async () => {
    const io = createBufferedPromptIO({ inputs: ["", "redis"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search"],
          validate: { min: 1 },
        }),
      ],
      io,
    });
    expect(answers.addons).toEqual(["redis"]);
    expect(io.stderr()).toContain("select at least 1 item(s)");
  });
});

describe("collectPrompts — --yes and --no-interactive without recipe default", () => {
  test("--yes with a defaultless confirm fails fast with RecipeMissingAnswerError", async () => {
    const promise = collectPrompts({
      prompts: [prompt({ name: "ssl", type: "confirm", message: "Enable SSL?" })],
      yes: true,
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipeMissingAnswerError);
    await expect(promise).rejects.toMatchObject({ _tag: "RecipeMissingAnswerError", promptName: "ssl" });
  });

  test("non-interactive defaultless multiselect fails fast with RecipeMissingAnswerError", async () => {
    const promise = collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["a", "b"],
        }),
      ],
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipeMissingAnswerError);
  });

  test("--yes accepts an explicit recipe default for confirm (default: false honored, not coerced to true)", async () => {
    const answers = await collectPrompts({
      prompts: [prompt({ name: "ssl", type: "confirm", message: "Enable SSL?", default: false })],
      yes: true,
      nonInteractive: true,
    });
    expect(answers.ssl).toBe(false);
  });
});

describe("parseAnswerFlags", () => {
  test("parses key=value entries; later wins; ignores malformed", () => {
    const parsed = parseAnswerFlags(["name=mvp", "port=80", "name=second", "noequals"]);
    expect(parsed).toEqual({ name: "second", port: "80" });
  });
});

describe("collectPrompts — tagged error shape", () => {
  test("RecipeMissingAnswerError carries the canonical _tag", async () => {
    const promise = collectPrompts({
      prompts: [prompt({ name: "name", type: "text", message: "App name" })],
      nonInteractive: true,
    });
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipeMissingAnswerError",
      promptName: "name",
    });
  });

  test("RecipePromptValidationError carries _tag and promptType", async () => {
    const promise = collectPrompts({
      prompts: [
        prompt({
          name: "port",
          type: "number",
          message: "Port",
          validate: { min: 1, max: 65535 },
        }),
      ],
      answers: { port: "abc" },
      nonInteractive: true,
    });
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipePromptValidationError",
      promptName: "port",
      promptType: "number",
    });
  });
});

describe("collectPrompts — select with numeric choice values", () => {
  test("literal numeric value wins over index lookup", async () => {
    const io = createBufferedPromptIO({ inputs: ["443"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "port",
          type: "select",
          message: "Port",
          choices: [80, 443, 8080],
        }),
      ],
      io,
    });
    expect(answers.port).toBe(443);
  });

  test("digit-only input falls back to 1-based index when no literal value matches", async () => {
    const io = createBufferedPromptIO({ inputs: ["2"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "db",
          type: "select",
          message: "Pick a database",
          choices: ["mysql", "postgres"],
        }),
      ],
      io,
    });
    expect(answers.db).toBe("postgres");
  });
});

describe("collectPrompts — multiselect validate.min/max", () => {
  test("non-interactive: too few selections raises RecipePromptValidationError", async () => {
    const promise = collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search", "queue"],
          validate: { min: 2 },
        }),
      ],
      answers: { addons: "redis" },
      nonInteractive: true,
    });
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipePromptValidationError",
      promptType: "multiselect",
    });
  });

  test("non-interactive: too many selections raises RecipePromptValidationError", async () => {
    const promise = collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search", "queue"],
          validate: { max: 1 },
        }),
      ],
      answers: { addons: "redis,search" },
      nonInteractive: true,
    });
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipePromptValidationError",
      promptType: "multiselect",
    });
  });

  test("interactive: blank input re-prompts when validate.min is set", async () => {
    const io = createBufferedPromptIO({ inputs: ["", "redis"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search"],
          validate: { min: 1 },
        }),
      ],
      io,
    });
    expect(answers.addons).toEqual(["redis"]);
    expect(io.stderr()).toContain("select at least 1 item(s)");
  });
});

describe("collectPrompts — non-interactive default-less prompts fail fast", () => {
  test("--yes on a default-less confirm raises RecipeMissingAnswerError (not synthesized true)", async () => {
    const promise = collectPrompts({
      prompts: [prompt({ name: "ssl", type: "confirm", message: "Enable SSL?" })],
      yes: true,
      nonInteractive: true,
    });
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipeMissingAnswerError",
      promptName: "ssl",
    });
  });

  test("--no-interactive on a default-less multiselect raises RecipeMissingAnswerError (not synthesized [])", async () => {
    const promise = collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search"],
        }),
      ],
      nonInteractive: true,
    });
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipeMissingAnswerError",
      promptName: "addons",
    });
  });

  test("--yes on a confirm with default: false honors the recipe default (does not force true)", async () => {
    const answers = await collectPrompts({
      prompts: [prompt({ name: "ssl", type: "confirm", message: "Enable SSL?", default: false })],
      yes: true,
      nonInteractive: true,
    });
    expect(answers.ssl).toBe(false);
  });
});

describe("collectPrompts — editor", () => {
  test("interactive: opens a scripted $VISUAL editor and captures the multi-line buffer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-editor-test-"));
    const script = join(dir, "fake-editor.sh");
    await writeFile(script, 'printf "First line\\nSecond line\\nThird line\\n" > "$1"\n', "utf8");
    try {
      const io = createBufferedPromptIO({ inputs: [], isTTY: true });
      const answers = await collectPrompts({
        prompts: [prompt({ name: "notes", type: "editor", message: "Edit notes" })],
        io,
        editorRunner: createDefaultEditorRunner({ env: { ...process.env, VISUAL: `sh ${script}` } }),
      });
      expect(answers.notes).toBe("First line\nSecond line\nThird line\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("interactive: seeds the buffer with the recipe default and applies validate rules", async () => {
    const seeds: string[] = [];
    const runner: EditorRunner = async ({ content }) => {
      seeds.push(content);
      return { kind: "edited", content: "release/v4.0.0" };
    };
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "branch",
          type: "editor",
          message: "Branch",
          default: "main",
          validate: { pattern: "^[a-z0-9./-]+$", message: "lowercase only" },
        }),
      ],
      io,
      editorRunner: runner,
    });
    expect(answers.branch).toBe("release/v4.0.0");
    expect(seeds).toEqual(["main"]);
  });

  test("interactive: re-opens the editor on validation failure until the buffer is valid", async () => {
    let call = 0;
    const runner: EditorRunner = async () => {
      call += 1;
      return { kind: "edited", content: call === 1 ? "Bad Value" : "good-value" };
    };
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "slug",
          type: "editor",
          message: "Slug",
          validate: { pattern: "^[a-z][a-z0-9-]*$", message: "kebab-case only" },
        }),
      ],
      io,
      editorRunner: runner,
    });
    expect(answers.slug).toBe("good-value");
    expect(call).toBe(2);
    expect(io.stderr()).toContain("Invalid value: kebab-case only");
  });

  test("interactive: skips external editor when stdin is not a TTY and reads a line instead", async () => {
    let editorInvoked = false;
    const runner: EditorRunner = async () => {
      editorInvoked = true;
      return { kind: "edited", content: "from editor" };
    };
    const io = createBufferedPromptIO({ inputs: ["typed non-tty"], isTTY: false });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "notes", type: "editor", message: "Edit notes" })],
      io,
      editorRunner: runner,
    });
    expect(answers.notes).toBe("typed non-tty");
    expect(editorInvoked).toBe(false);
  });

  test("interactive: falls back to text line read when no editor is configured (no hang)", async () => {
    const io = createBufferedPromptIO({ inputs: ["typed inline"], isTTY: true });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "notes", type: "editor", message: "Edit notes" })],
      io,
      editorRunner: createDefaultEditorRunner({ env: { VISUAL: "", EDITOR: "" } }),
    });
    expect(answers.notes).toBe("typed inline");
  });

  test("interactive: falls back to text line read when the editor exits non-zero", async () => {
    const io = createBufferedPromptIO({ inputs: ["typed after failure"], isTTY: true });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "notes", type: "editor", message: "Edit notes", default: "stale seed" })],
      io,
      editorRunner: createDefaultEditorRunner({
        env: { VISUAL: "false" },
      }),
    });
    expect(answers.notes).toBe("typed after failure");
    expect(io.stderr()).toContain('Editor command failed for prompt "notes": editor exited with code 1');
  });

  test("non-interactive: resolves the recipe default with text semantics", async () => {
    const answers = await collectPrompts({
      prompts: [prompt({ name: "notes", type: "editor", message: "Edit notes", default: "seeded" })],
      nonInteractive: true,
    });
    expect(answers.notes).toBe("seeded");
  });

  test("non-interactive: missing required editor answer raises RecipeMissingAnswerError", async () => {
    const promise = collectPrompts({
      prompts: [prompt({ name: "notes", type: "editor", message: "Edit notes" })],
      nonInteractive: true,
    });
    await expect(promise).rejects.toMatchObject({
      _tag: "RecipeMissingAnswerError",
      promptName: "notes",
    });
  });

  test("supplied --answer for an editor prompt is validated as text", async () => {
    const answers = await collectPrompts({
      prompts: [prompt({ name: "notes", type: "editor", message: "Edit notes" })],
      answers: { notes: "supplied multi\nline" },
      nonInteractive: true,
    });
    expect(answers.notes).toBe("supplied multi\nline");
  });
});

describe("resolveEditorCommand", () => {
  test("prefers $VISUAL over $EDITOR and splits argv", () => {
    expect(resolveEditorCommand({ VISUAL: "code --wait", EDITOR: "vi" })).toEqual({
      cmd: "code",
      args: ["--wait"],
    });
  });

  test("preserves quoted command paths and arguments", () => {
    expect(
      resolveEditorCommand({ VISUAL: '"/opt/Visual Studio Code/bin/code" --wait -c "set ft=yaml"' }),
    ).toEqual({
      cmd: "/opt/Visual Studio Code/bin/code",
      args: ["--wait", "-c", "set ft=yaml"],
    });
  });

  test("falls back to $EDITOR when $VISUAL is empty/whitespace", () => {
    expect(resolveEditorCommand({ VISUAL: "  ", EDITOR: "nano" })).toEqual({ cmd: "nano", args: [] });
  });

  test("returns undefined when neither is configured", () => {
    expect(resolveEditorCommand({})).toBeUndefined();
    expect(resolveEditorCommand({ VISUAL: "", EDITOR: "" })).toBeUndefined();
  });
});
