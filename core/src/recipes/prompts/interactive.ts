import type { PromptAnswer, RecipePrompt, RecipePromptChoice } from "@lando/sdk/schema";
import { canOmitAnswer, promptDefaultRaw } from "./answer-resolution.ts";
import { choiceLabel, coerceAnswer } from "./coerce.ts";
import {
  PromptCancelledError,
  type PromptChrome,
  type PromptDriver,
  type PromptDriverMode,
} from "./driver.ts";
import type { EditorRunner } from "./editor-command.ts";
import type { PromptIO } from "./io.ts";
import { type CoerceResult, enforceMultiSelectBounds, validateTypedAnswer } from "./validation.ts";

const defaultHint = (prompt: RecipePrompt): string => {
  if (canOmitAnswer(prompt)) return "(optional; blank to skip)";
  if (prompt.type === "confirm") {
    if (typeof prompt.default === "boolean") return prompt.default ? "(Y/n)" : "(y/N)";
    return "(y/n)";
  }
  if (prompt.default === undefined) return "";
  if (prompt.type === "secret") return "(default: <hidden>)";
  return `(default: ${String(prompt.default)})`;
};

export const renderManualChoiceLine = (prompt: RecipePrompt): string => {
  const hint = prompt.default === undefined ? "" : `(default: ${String(prompt.default)})`;
  const base = hint === "" ? prompt.message : `${prompt.message} ${hint}`;
  const blankHint = canOmitAnswer(prompt) ? "blank to skip" : "blank for none";
  return prompt.type === "multiselect" ? `${base}\n(comma-separated values; ${blankHint}): ` : `${base}: `;
};

const renderPromptLine = (prompt: RecipePrompt): string => {
  if (prompt.validate?.items !== undefined) return renderManualChoiceLine(prompt);
  if (prompt.type === "select" || prompt.type === "multiselect") {
    const blankHint = canOmitAnswer(prompt) ? "blank to skip" : "blank for none";
    const tail =
      prompt.type === "multiselect"
        ? `\n(comma-separated values or indices; ${blankHint}): `
        : canOmitAnswer(prompt)
          ? "\n(value or index; blank to skip): "
          : "\n(value or index): ";
    const choices = (prompt.choices ?? [])
      .map((choice, index) => `  ${index + 1}) ${choiceLabel(choice)}`)
      .join("\n");
    return `${prompt.message}\n${choices}${tail}`;
  }
  const hint = defaultHint(prompt);
  return hint === "" ? `${prompt.message}: ` : `${prompt.message} ${hint}: `;
};

export const runDriverPrompt = async (
  prompt: RecipePrompt,
  driver: PromptDriver,
  options: {
    readonly mode: PromptDriverMode;
    readonly coerce: (raw: string) => Promise<CoerceResult> | CoerceResult;
    readonly choices?: readonly RecipePromptChoice[];
    readonly chrome?: PromptChrome;
  },
): Promise<PromptAnswer | undefined> => {
  const def = promptDefaultRaw(prompt);
  let issue: string | undefined;
  while (true) {
    const raw = await driver.readRaw({
      prompt,
      mode: options.mode,
      ...(def.hasDefault ? { defaultRaw: def.raw } : {}),
      ...(issue === undefined ? {} : { issue }),
      ...(options.choices === undefined ? {} : { choices: options.choices }),
      ...(options.chrome?.help === undefined ? {} : { help: options.chrome.help }),
      ...(options.chrome?.footer === undefined ? {} : { footer: options.chrome.footer }),
    });
    if (raw === "" && canOmitAnswer(prompt)) return undefined;
    if (raw === "" && prompt.validate?.valueType !== undefined && prompt.default !== undefined) {
      const result = validateTypedAnswer(prompt, prompt.default);
      if (result.ok) return result.value;
      issue = result.issue;
      continue;
    }
    const effective = raw === "" && def.hasDefault ? def.raw : raw;
    if (effective === "" && prompt.validate?.valueType === undefined) {
      if (prompt.type === "multiselect") {
        const bounds = enforceMultiSelectBounds(prompt, 0);
        if (bounds.ok) return [];
        issue = bounds.issue;
        continue;
      }
      issue = "Value is required.";
      continue;
    }
    const result = await options.coerce(effective);
    if (result.ok) return result.value;
    issue = result.issue;
  }
};

export const tryDriverPrompt = async (
  run: () => Promise<PromptAnswer | undefined>,
): Promise<{ readonly ok: true; readonly value: PromptAnswer | undefined } | { readonly ok: false }> => {
  try {
    return { ok: true, value: await run() };
  } catch (cause) {
    if (cause instanceof PromptCancelledError) throw cause;
    return { ok: false };
  }
};

type PromptSession = {
  readonly io: PromptIO;
  readonly cwd: string;
  readonly driver?: PromptDriver | undefined;
  readonly editorRunner?: EditorRunner | undefined;
  readonly chrome?: PromptChrome | undefined;
};

const runEditorPrompt = async (
  prompt: RecipePrompt,
  session: PromptSession,
  editorRunner: EditorRunner,
): Promise<{ readonly value: PromptAnswer | undefined } | undefined> => {
  const def = promptDefaultRaw(prompt);
  let seed = def.hasDefault ? def.raw : "";
  while (true) {
    const result = await editorRunner({ name: prompt.name, content: seed, cwd: session.cwd });
    switch (result.kind) {
      case "no-editor":
        return undefined;
      case "failed":
        session.io.writeError(
          `Editor command failed for prompt "${prompt.name}": ${result.reason}. Falling back to text input.\n`,
        );
        return undefined;
      case "edited": {
        if (result.content === "" && canOmitAnswer(prompt)) return { value: undefined };
        const effective = result.content === "" && def.hasDefault ? def.raw : result.content;
        if (effective === "" && prompt.validate?.valueType === undefined) {
          session.io.writeError("Value is required. Please try again.\n");
          seed = result.content;
          break;
        }
        const coerced = await coerceAnswer(prompt, effective, session.cwd);
        if (coerced.ok) return { value: coerced.value };
        session.io.writeError(`Invalid value: ${coerced.issue}. Please try again.\n`);
        seed = effective;
        break;
      }
      default:
        return result satisfies never;
    }
  }
};

export const runInteractivePrompt = async (
  prompt: RecipePrompt,
  session: PromptSession,
): Promise<PromptAnswer | undefined> => {
  const { io, cwd, driver, editorRunner, chrome } = session;
  if (prompt.type === "editor" && editorRunner !== undefined && io.isTTY) {
    const edited = await runEditorPrompt(prompt, session, editorRunner);
    if (edited !== undefined) return edited.value;
  }
  // Select/confirm widgets always choose a value; line input can represent omission.
  const needsOmissionInput = canOmitAnswer(prompt) && (prompt.type === "select" || prompt.type === "confirm");
  if (driver !== undefined && io.isTTY && !needsOmissionInput) {
    const outcome = await tryDriverPrompt(() =>
      runDriverPrompt(prompt, driver, {
        mode: prompt.validate?.items === undefined ? "normal" : "manual-choice",
        coerce: (raw) => coerceAnswer(prompt, raw, cwd),
        ...(prompt.choices === undefined ? {} : { choices: prompt.choices }),
        ...(chrome === undefined ? {} : { chrome }),
      }),
    );
    if (outcome.ok) return outcome.value;
  }
  const def = promptDefaultRaw(prompt);
  while (true) {
    io.write(renderPromptLine(prompt));
    const raw = await io.readLine(prompt.type === "secret" ? { secret: true } : undefined);
    if (raw === "" && canOmitAnswer(prompt)) return undefined;
    if (raw === "" && prompt.validate?.valueType !== undefined && prompt.default !== undefined) {
      const result = validateTypedAnswer(prompt, prompt.default);
      if (result.ok) return result.value;
      io.writeError(`Invalid value: ${result.issue}. Please try again.\n`);
      continue;
    }
    const effective = raw === "" && def.hasDefault ? def.raw : raw;
    if (effective === "" && prompt.validate?.valueType === undefined) {
      if (prompt.type === "multiselect") {
        const bounds = enforceMultiSelectBounds(prompt, 0);
        if (bounds.ok) return [];
        io.writeError(`Invalid value: ${bounds.issue}. Please try again.\n`);
        continue;
      }
      io.writeError("Value is required. Please try again.\n");
      continue;
    }
    const result = await coerceAnswer(prompt, effective, cwd);
    if (result.ok) return result.value;
    io.writeError(`Invalid value: ${result.issue}. Please try again.\n`);
  }
};
