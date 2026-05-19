import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { RecipeMissingAnswerError, RecipePromptValidationError } from "@lando/sdk/errors";
import { RecipePrompt } from "@lando/sdk/schema";

import {
  collectPrompts,
  createBufferedPromptIO,
  parseAnswerFlags,
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

describe("parseAnswerFlags", () => {
  test("parses key=value entries; later wins; ignores malformed", () => {
    const parsed = parseAnswerFlags(["name=mvp", "port=80", "name=second", "noequals"]);
    expect(parsed).toEqual({ name: "second", port: "80" });
  });
});
