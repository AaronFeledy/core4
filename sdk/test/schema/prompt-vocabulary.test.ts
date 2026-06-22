import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  ChoicesUnavailableError,
  InteractionCancelledError,
  InteractionRequiredError,
  InteractionUnavailableError,
  PromptValidationError,
  RecipeChoicesError,
  RecipeMissingAnswerError,
  RecipePromptValidationError,
} from "@lando/sdk/errors";
import {
  ChoicesFrom,
  InteractionServiceContribution,
  PluginManifest,
  PromptAnswer,
  PromptChoice,
  PromptSpec,
  PromptType,
  PromptValidate,
  RecipeChoicesFrom,
  RecipePrompt,
  RecipePromptChoice,
  RecipePromptType,
  RecipePromptValidate,
} from "@lando/sdk/schema";
import { InteractionService } from "@lando/sdk/services";

describe("PromptSpec vocabulary", () => {
  test("PromptType exposes all eight prompt types including editor, with editor last", () => {
    expect(PromptType.literals).toEqual([
      "text",
      "select",
      "multiselect",
      "confirm",
      "number",
      "secret",
      "path",
      "editor",
    ]);
  });

  test("PromptSpec decodes an editor-type prompt", () => {
    const decoded = Schema.decodeUnknownSync(PromptSpec)({
      name: "notes",
      type: "editor",
      message: "Edit your notes",
    });
    expect(decoded.type).toBe("editor");
    expect(decoded.name).toBe("notes");
  });

  test("PromptSpec decodes a select prompt with choices and choicesFrom", () => {
    const decoded = Schema.decodeUnknownSync(PromptSpec)({
      name: "port",
      type: "select",
      message: "Pick a port",
      choices: [80, { value: 443, label: "https" }],
      choicesFrom: { command: "lando", args: ["x"], parse: "json" },
      validate: { min: 1 },
    });
    expect(decoded.choices?.length).toBe(2);
    expect(decoded.choicesFrom?.parse).toBe("json");
  });

  test("PromptAnswer admits scalars and arrays", () => {
    expect(Schema.decodeUnknownSync(PromptAnswer)("a")).toBe("a");
    expect(Schema.decodeUnknownSync(PromptAnswer)(3)).toBe(3);
    expect(Schema.decodeUnknownSync(PromptAnswer)(true)).toBe(true);
    expect(Schema.decodeUnknownSync(PromptAnswer)(["a", "b"])).toEqual(["a", "b"]);
  });

  test("PromptChoice / PromptValidate / ChoicesFrom decode standalone", () => {
    expect(Schema.decodeUnknownSync(PromptChoice)("x")).toBe("x");
    expect(Schema.decodeUnknownSync(PromptValidate)({ pattern: "^x$" }).pattern).toBe("^x$");
    expect(Schema.decodeUnknownSync(ChoicesFrom)({ command: "c", parse: "lines" }).parse).toBe("lines");
  });
});

describe("RecipePrompt is PromptSpec + recipe-only fields with unchanged serialized shape", () => {
  test("recipe sub-schemas alias the generalized vocabulary", () => {
    expect(RecipePromptType).toBe(PromptType);
    expect(RecipePromptChoice).toBe(PromptChoice);
    expect(RecipePromptValidate).toBe(PromptValidate);
    expect(RecipeChoicesFrom).toBe(ChoicesFrom);
  });

  test("RecipePrompt decodes recipe-only when/deprecated fields", () => {
    const decoded = Schema.decodeUnknownSync(RecipePrompt)({
      name: "ssl",
      type: "confirm",
      message: "Enable SSL?",
      when: "answers.kind === 'web'",
    });
    expect(decoded.name).toBe("ssl");
    expect(decoded.when).toBe("answers.kind === 'web'");
  });
});

describe("generalized interaction errors", () => {
  test("each generalized error carries its own _tag", () => {
    expect(new InteractionRequiredError({ message: "m", promptName: "p", remediation: "r" })._tag).toBe(
      "InteractionRequiredError",
    );
    expect(
      new PromptValidationError({
        message: "m",
        promptName: "p",
        promptType: "text",
        issue: "i",
        remediation: "r",
      })._tag,
    ).toBe("PromptValidationError");
    expect(new InteractionCancelledError({ message: "m" })._tag).toBe("InteractionCancelledError");
    expect(
      new ChoicesUnavailableError({
        message: "m",
        promptName: "p",
        command: "c",
        kind: "empty",
        remediation: "r",
      })._tag,
    ).toBe("ChoicesUnavailableError");
    expect(new InteractionUnavailableError({ message: "m", remediation: "r" })._tag).toBe(
      "InteractionUnavailableError",
    );
  });

  test("recipe errors keep their existing _tags and field shapes (no migration)", () => {
    expect(new RecipeMissingAnswerError({ message: "m", promptName: "p", remediation: "r" })._tag).toBe(
      "RecipeMissingAnswerError",
    );
    expect(
      new RecipePromptValidationError({
        message: "m",
        promptName: "p",
        promptType: "text",
        issue: "i",
        remediation: "r",
      })._tag,
    ).toBe("RecipePromptValidationError");
    expect(
      new RecipeChoicesError({
        message: "m",
        promptName: "p",
        command: "c",
        kind: "command-failed",
        remediation: "r",
      })._tag,
    ).toBe("RecipeChoicesError");
  });
});

describe("InteractionService manifest surface", () => {
  test("InteractionServiceContribution decodes capabilities", () => {
    const decoded = Schema.decodeUnknownSync(InteractionServiceContribution)({
      id: "fancy",
      module: "./interaction.ts",
      capabilities: { interactive: true, promptTypes: ["text", "secret"], secretRedaction: true },
    });
    expect(decoded.id).toBe("fancy");
    expect(decoded.capabilities.secretRedaction).toBe(true);
  });

  test("InteractionServiceContribution requires module and capabilities", () => {
    expect(() =>
      Schema.decodeUnknownSync(InteractionServiceContribution)({
        id: "fancy",
      }),
    ).toThrow();
  });

  test("InteractionServiceContribution rejects the core-reserved stdio id", () => {
    expect(() =>
      Schema.decodeUnknownSync(InteractionServiceContribution)({
        id: "stdio",
        module: "./interaction.ts",
        capabilities: { interactive: true, promptTypes: ["text"], secretRedaction: true },
      }),
    ).toThrow();
  });

  test("InteractionServiceContribution rejects an unknown prompt type", () => {
    expect(() =>
      Schema.decodeUnknownSync(InteractionServiceContribution)({
        id: "fancy",
        module: "./interaction.ts",
        capabilities: { interactive: true, promptTypes: ["bogus"], secretRedaction: true },
      }),
    ).toThrow();
  });

  test("PluginManifest accepts contributes.interactionServices[]", () => {
    const decoded = Schema.decodeUnknownSync(PluginManifest)({
      name: "@scope/plugin",
      version: "1.0.0",
      api: 4,
      contributes: {
        interactionServices: [
          {
            id: "fancy",
            module: "./interaction.ts",
            capabilities: { interactive: true, promptTypes: ["text"], secretRedaction: false },
          },
        ],
      },
    });
    expect(decoded.contributes?.interactionServices?.[0]?.id).toBe("fancy");
  });
});

describe("InteractionService service tag", () => {
  test("tag key is @lando/core/InteractionService", () => {
    expect(InteractionService.key).toBe("@lando/core/InteractionService");
  });
});
