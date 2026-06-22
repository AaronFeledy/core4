/**
 * Built-in recipe prompt runtime: drives the eight prompt
 * types (`text | select | multiselect | confirm | number | secret |
 * path | editor`) through a `PromptIO`. The `editor` type opens
 * `$VISUAL`/`$EDITOR` on a temp-file buffer through an injectable
 * editor runner and falls back to `text` semantics when no editor is
 * configured or the prompt resolves non-interactively. Non-interactive
 * mode (`nonInteractive: true`, or `io === undefined`) requires every
 * required prompt to be answered via `answers` or to have a recipe
 * `default:`; missing answers fail with `RecipeMissingAnswerError` and
 * invalid answers fail with `RecipePromptValidationError`. Interactive
 * mode re-prompts on validation failure; `secret` answers are never
 * echoed and never appear in any transcript or error message.
 */
import { access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { RecipeChoicesError, RecipeMissingAnswerError, RecipePromptValidationError } from "@lando/sdk/errors";
import type { RecipeChoicesFrom, RecipePrompt, RecipePromptChoice } from "@lando/sdk/schema";

import { defaultRunWarning, evaluateRunPermission, runNotAllowedError } from "../run-allowlist.ts";
import {
  type ChoicesCommandRunner,
  ChoicesParseFailure,
  type ChoicesParseFailureKind,
  createDefaultChoicesCommandRunner,
  parseChoicesOutput,
} from "./choices-command.ts";
import { PromptCancelledError, type PromptDriver, type PromptDriverMode } from "./driver.ts";
import { type EditorRunner, createDefaultEditorRunner } from "./editor-command.ts";
import type { PromptIO } from "./io.ts";

export type PromptAnswer = string | number | boolean | ReadonlyArray<string | number | boolean>;

export type PromptAnswers = Readonly<Record<string, PromptAnswer>>;

export interface CollectPromptsOptions {
  readonly prompts: ReadonlyArray<RecipePrompt>;
  readonly answers?: Readonly<Record<string, string>>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly cwd?: string;
  readonly io?: PromptIO;
  readonly choicesRunner?: ChoicesCommandRunner;
  readonly runs?: ReadonlyArray<string>;
  readonly interactiveDriver?: PromptDriver;
  readonly editorRunner?: EditorRunner;
}

const ACCEPTED_BOOL_TRUE = new Set(["y", "yes", "true", "1", "on"]);
const ACCEPTED_BOOL_FALSE = new Set(["n", "no", "false", "0", "off"]);

type CoerceResult =
  | { readonly ok: true; readonly value: PromptAnswer }
  | { readonly ok: false; readonly issue: string };

const choiceValue = (choice: RecipePromptChoice): string | number | boolean =>
  typeof choice === "object" && choice !== null && "value" in choice ? choice.value : choice;

const choiceLabel = (choice: RecipePromptChoice): string =>
  typeof choice === "object" && choice !== null && "value" in choice
    ? (choice.label ?? String(choice.value))
    : String(choice);

const validateText = (prompt: RecipePrompt, raw: string): CoerceResult => {
  const pattern = prompt.validate?.pattern;
  if (pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return { ok: false, issue: `recipe pattern "${pattern}" is not a valid regex` };
    }
    if (!re.test(raw)) {
      return { ok: false, issue: prompt.validate?.message ?? `value must match ${pattern}` };
    }
  }
  return { ok: true, value: raw };
};

const validateNumber = (prompt: RecipePrompt, raw: string): CoerceResult => {
  if (raw.trim() === "") return { ok: false, issue: "a number is required" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { ok: false, issue: `"${raw}" is not a number` };
  }
  const { min, max } = prompt.validate ?? {};
  if (min !== undefined && parsed < min) {
    return { ok: false, issue: `value must be >= ${String(min)}` };
  }
  if (max !== undefined && parsed > max) {
    return { ok: false, issue: `value must be <= ${String(max)}` };
  }
  return { ok: true, value: parsed };
};

const validateConfirm = (raw: string): CoerceResult => {
  const norm = raw.trim().toLowerCase();
  if (ACCEPTED_BOOL_TRUE.has(norm)) return { ok: true, value: true };
  if (ACCEPTED_BOOL_FALSE.has(norm)) return { ok: true, value: false };
  return { ok: false, issue: `expected yes/no, got "${raw}"` };
};

const resolveSelection = (prompt: RecipePrompt, raw: string): CoerceResult => {
  const choices = prompt.choices ?? [];
  if (choices.length === 0) {
    return { ok: false, issue: "select prompt requires choices" };
  }
  const trimmed = raw.trim();
  // Try exact value/label match first so that numeric choice values
  // (e.g. choices: [80, 443]) remain reachable. Fall back to 1-based
  // index lookup when the input is digit-only and not a literal match.
  for (const choice of choices) {
    const value = choiceValue(choice);
    if (String(value) === trimmed || choiceLabel(choice) === trimmed) {
      return { ok: true, value };
    }
  }
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    const picked = choices[index];
    if (picked === undefined) {
      return { ok: false, issue: `selection index ${trimmed} is out of range` };
    }
    return { ok: true, value: choiceValue(picked) };
  }
  return { ok: false, issue: `no choice matches "${trimmed}"` };
};

const enforceMultiSelectBounds = (
  prompt: RecipePrompt,
  count: number,
): { readonly ok: true } | { readonly ok: false; readonly issue: string } => {
  const { min, max } = prompt.validate ?? {};
  if (min !== undefined && count < min) {
    return { ok: false, issue: `select at least ${String(min)} item(s)` };
  }
  if (max !== undefined && count > max) {
    return { ok: false, issue: `select at most ${String(max)} item(s)` };
  }
  return { ok: true };
};

const resolveMultiSelection = (prompt: RecipePrompt, raw: string): CoerceResult => {
  const trimmed = raw.trim();
  const parts =
    trimmed === ""
      ? []
      : trimmed
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "");
  const out: Array<string | number | boolean> = [];
  for (const part of parts) {
    const result = resolveSelection(prompt, part);
    if (!result.ok) return result;
    const scalar = result.value as string | number | boolean;
    if (!out.includes(scalar)) out.push(scalar);
  }
  const bounds = enforceMultiSelectBounds(prompt, out.length);
  if (!bounds.ok) return { ok: false, issue: bounds.issue };
  return { ok: true, value: out };
};

const validatePath = async (prompt: RecipePrompt, raw: string, cwd: string): Promise<CoerceResult> => {
  if (raw.trim() === "") return { ok: false, issue: "a path is required" };
  const text = validateText(prompt, raw);
  if (!text.ok) return text;
  const absolute = resolvePath(cwd, raw);
  if (prompt.validate?.exists === true) {
    try {
      await access(absolute);
    } catch {
      return { ok: false, issue: `path does not exist: ${absolute}` };
    }
  }
  return { ok: true, value: absolute };
};

const coerceAnswer = (prompt: RecipePrompt, raw: string, cwd: string): Promise<CoerceResult> => {
  switch (prompt.type) {
    case "text":
    case "secret":
    // `editor` validates its edited buffer (and any supplied answer or
    // recipe default) with the same text rules; the interactive editor
    // launch happens in `runEditorPrompt`, not here.
    case "editor":
      return Promise.resolve(validateText(prompt, raw));
    case "number":
      return Promise.resolve(validateNumber(prompt, raw));
    case "confirm":
      return Promise.resolve(validateConfirm(raw));
    case "select":
      return Promise.resolve(resolveSelection(prompt, raw));
    case "multiselect":
      return Promise.resolve(resolveMultiSelection(prompt, raw));
    case "path":
      return validatePath(prompt, raw, cwd);
  }
};

const defaultHint = (prompt: RecipePrompt): string => {
  if (prompt.type === "confirm") {
    if (typeof prompt.default === "boolean") return prompt.default ? "(Y/n)" : "(y/N)";
    return "(y/n)";
  }
  if (prompt.default === undefined) return "";
  if (prompt.type === "secret") return "(default: <hidden>)";
  return `(default: ${String(prompt.default)})`;
};

const renderChoiceList = (choices: ReadonlyArray<RecipePromptChoice>): string =>
  choices.map((choice, index) => `  ${String(index + 1)}) ${choiceLabel(choice)}`).join("\n");

const renderPromptLine = (prompt: RecipePrompt): string => {
  if (prompt.type === "select" || prompt.type === "multiselect") {
    const tail =
      prompt.type === "multiselect"
        ? "\n(comma-separated values or indices; blank for none): "
        : "\n(value or index): ";
    return `${prompt.message}\n${renderChoiceList(prompt.choices ?? [])}${tail}`;
  }
  const hint = defaultHint(prompt);
  return hint === "" ? `${prompt.message}: ` : `${prompt.message} ${hint}: `;
};

const promptDefaultRaw = (
  prompt: RecipePrompt,
): { readonly hasDefault: true; readonly raw: string } | { readonly hasDefault: false } => {
  if (prompt.default === undefined) return { hasDefault: false };
  return { hasDefault: true, raw: String(prompt.default) };
};

const missingAnswer = (prompt: RecipePrompt): RecipeMissingAnswerError =>
  new RecipeMissingAnswerError({
    message: `Missing required answer for prompt "${prompt.name}".`,
    promptName: prompt.name,
    remediation: `Provide it via --answer ${prompt.name}=<value> or add a default to the recipe.`,
  });

const validationFail = (
  prompt: RecipePrompt,
  issue: string,
  remediation: string,
): RecipePromptValidationError =>
  new RecipePromptValidationError({
    message: `Invalid value for prompt "${prompt.name}": ${issue}`,
    promptName: prompt.name,
    promptType: prompt.type,
    issue,
    remediation,
  });

const resolveSupplied = async (
  prompt: RecipePrompt,
  supplied: string,
  cwd: string,
): Promise<PromptAnswer> => {
  const result = await coerceAnswer(prompt, supplied, cwd);
  if (!result.ok) {
    throw validationFail(
      prompt,
      result.issue,
      `Update --answer ${prompt.name}=<value> with a value that satisfies the recipe constraint.`,
    );
  }
  return result.value;
};

const resolveDefault = async (
  prompt: RecipePrompt,
  defaultRaw: string,
  cwd: string,
): Promise<PromptAnswer> => {
  const result = await coerceAnswer(prompt, defaultRaw, cwd);
  if (!result.ok) {
    throw validationFail(
      prompt,
      result.issue,
      "The recipe default for this prompt failed validation; report this to the recipe author.",
    );
  }
  return result.value;
};

const runDriverPrompt = async (
  prompt: RecipePrompt,
  driver: PromptDriver,
  mode: PromptDriverMode,
  coerce: (effective: string) => Promise<CoerceResult> | CoerceResult,
  choices?: ReadonlyArray<RecipePromptChoice>,
): Promise<PromptAnswer> => {
  const def = promptDefaultRaw(prompt);
  let issue: string | undefined;
  while (true) {
    const raw = await driver.readRaw({
      prompt,
      mode,
      ...(def.hasDefault ? { defaultRaw: def.raw } : {}),
      ...(issue === undefined ? {} : { issue }),
      ...(choices === undefined ? {} : { choices }),
    });
    const effective = raw === "" && def.hasDefault ? def.raw : raw;
    if (effective === "") {
      if (prompt.type === "multiselect") {
        const bounds = enforceMultiSelectBounds(prompt, 0);
        if (bounds.ok) return [];
        issue = bounds.issue;
        continue;
      }
      issue = "Value is required.";
      continue;
    }
    const result = await coerce(effective);
    if (result.ok) return result.value;
    issue = result.issue;
  }
};

type DriverOutcome = { readonly ok: true; readonly value: PromptAnswer } | { readonly ok: false };

const tryDriverPrompt = async (run: () => Promise<PromptAnswer>): Promise<DriverOutcome> => {
  try {
    return { ok: true, value: await run() };
  } catch (cause) {
    if (cause instanceof PromptCancelledError) throw cause;
    return { ok: false };
  }
};

const runEditorPrompt = async (
  prompt: RecipePrompt,
  io: PromptIO,
  cwd: string,
  editorRunner: EditorRunner,
): Promise<PromptAnswer | undefined> => {
  const def = promptDefaultRaw(prompt);
  let seed = def.hasDefault ? def.raw : "";
  while (true) {
    const result = await editorRunner({ name: prompt.name, content: seed, cwd });
    switch (result.kind) {
      case "no-editor":
        return undefined;
      case "failed":
        io.writeError(
          `Editor command failed for prompt "${prompt.name}": ${result.reason}. Falling back to text input.\n`,
        );
        return undefined;
      case "edited": {
        const effective = result.content === "" && def.hasDefault ? def.raw : result.content;
        if (effective === "") {
          io.writeError("Value is required. Please try again.\n");
          seed = result.content;
          break;
        }
        const coerced = await coerceAnswer(prompt, effective, cwd);
        if (coerced.ok) return coerced.value;
        io.writeError(`Invalid value: ${coerced.issue}. Please try again.\n`);
        seed = effective;
        break;
      }
    }
  }
};

const runInteractivePrompt = async (
  prompt: RecipePrompt,
  io: PromptIO,
  cwd: string,
  driver?: PromptDriver,
  editorRunner?: EditorRunner,
): Promise<PromptAnswer> => {
  if (prompt.type === "editor" && editorRunner !== undefined && io.isTTY) {
    const edited = await runEditorPrompt(prompt, io, cwd, editorRunner);
    if (edited !== undefined) return edited;
  }
  if (driver !== undefined && io.isTTY) {
    const outcome = await tryDriverPrompt(() =>
      runDriverPrompt(
        prompt,
        driver,
        "normal",
        (effective) => coerceAnswer(prompt, effective, cwd),
        prompt.choices,
      ),
    );
    if (outcome.ok) return outcome.value;
  }
  const def = promptDefaultRaw(prompt);
  while (true) {
    io.write(renderPromptLine(prompt));
    const raw = await io.readLine(prompt.type === "secret" ? { secret: true } : undefined);
    const effective = raw === "" && def.hasDefault ? def.raw : raw;
    if (effective === "") {
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

const isDynamicChoicesPrompt = (
  prompt: RecipePrompt,
): prompt is RecipePrompt & { choicesFrom: RecipeChoicesFrom } =>
  (prompt.type === "select" || prompt.type === "multiselect") && prompt.choicesFrom !== undefined;

type ChoicesOutcome =
  | { readonly ok: true; readonly choices: ReadonlyArray<RecipePromptChoice> }
  | {
      readonly ok: false;
      readonly kind: "command-failed" | ChoicesParseFailureKind;
      readonly reason: string;
      readonly exitCode?: number;
    };

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const runChoicesCommand = async (
  runner: ChoicesCommandRunner,
  choicesFrom: RecipeChoicesFrom,
): Promise<ChoicesOutcome> => {
  let result: Awaited<ReturnType<ChoicesCommandRunner>>;
  try {
    result = await runner({ command: choicesFrom.command, args: choicesFrom.args ?? [] });
  } catch (cause) {
    return { ok: false, kind: "command-failed", reason: `command failed to run: ${describeCause(cause)}` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      kind: "command-failed",
      reason: `command exited with code ${String(result.exitCode)}`,
      exitCode: result.exitCode,
    };
  }
  try {
    return { ok: true, choices: parseChoicesOutput(result.stdout, choicesFrom.parse) };
  } catch (cause) {
    if (cause instanceof ChoicesParseFailure) return { ok: false, kind: cause.kind, reason: cause.message };
    return { ok: false, kind: "unparseable", reason: describeCause(cause) };
  }
};

const splitMultiValues = (raw: string): ReadonlyArray<string> =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const acceptManualValue = (prompt: RecipePrompt, raw: string): CoerceResult => {
  if (prompt.type === "multiselect") {
    const values = splitMultiValues(raw);
    const bounds = enforceMultiSelectBounds(prompt, values.length);
    if (!bounds.ok) return { ok: false, issue: bounds.issue };
    return { ok: true, value: values };
  }
  return validateText(prompt, raw);
};

const renderManualChoiceLine = (prompt: RecipePrompt): string => {
  const hint = prompt.default === undefined ? "" : `(default: ${String(prompt.default)})`;
  const base = hint === "" ? prompt.message : `${prompt.message} ${hint}`;
  return prompt.type === "multiselect" ? `${base}\n(comma-separated values; blank for none): ` : `${base}: `;
};

const choicesError = (
  prompt: RecipePrompt,
  choicesFrom: RecipeChoicesFrom,
  outcome: Extract<ChoicesOutcome, { ok: false }>,
): RecipeChoicesError =>
  new RecipeChoicesError({
    message: `Could not load dynamic choices for prompt "${prompt.name}": ${outcome.reason}.`,
    promptName: prompt.name,
    command: choicesFrom.command,
    kind: outcome.kind,
    remediation: `Provide the value directly via --answer ${prompt.name}=<value>, or fix the \`${choicesFrom.command}\` command.`,
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
  });

const runManualChoiceFallback = async (
  prompt: RecipePrompt,
  io: PromptIO,
  reason: string,
  driver?: PromptDriver,
): Promise<PromptAnswer> => {
  io.writeError(`Could not load choices for "${prompt.name}" (${reason}). Enter the value manually.\n`);
  if (driver !== undefined && io.isTTY) {
    const outcome = await tryDriverPrompt(() =>
      runDriverPrompt(prompt, driver, "manual-choice", (effective) => acceptManualValue(prompt, effective)),
    );
    if (outcome.ok) return outcome.value;
  }
  const def = promptDefaultRaw(prompt);
  while (true) {
    io.write(renderManualChoiceLine(prompt));
    const raw = await io.readLine();
    const effective = raw === "" && def.hasDefault ? def.raw : raw;
    if (effective === "") {
      if (prompt.type === "multiselect") {
        const bounds = enforceMultiSelectBounds(prompt, 0);
        if (bounds.ok) return [];
        io.writeError(`Invalid value: ${bounds.issue}. Please try again.\n`);
        continue;
      }
      io.writeError("Value is required. Please try again.\n");
      continue;
    }
    const result = acceptManualValue(prompt, effective);
    if (result.ok) return result.value;
    io.writeError(`Invalid value: ${result.issue}. Please try again.\n`);
  }
};

const resolveDynamicSupplied = (prompt: RecipePrompt, supplied: string): PromptAnswer => {
  const result = acceptManualValue(prompt, supplied);
  if (!result.ok) {
    throw validationFail(
      prompt,
      result.issue,
      `Update --answer ${prompt.name}=<value> with a value that satisfies the recipe constraint.`,
    );
  }
  return result.value;
};

const resolveDynamicChoicesPrompt = async (
  prompt: RecipePrompt & { choicesFrom: RecipeChoicesFrom },
  context: {
    readonly supplied: string | undefined;
    readonly runner: ChoicesCommandRunner;
    readonly io: PromptIO | undefined;
    readonly interactive: boolean;
    readonly yes: boolean;
    readonly cwd: string;
    readonly runs: ReadonlyArray<string> | undefined;
    readonly driver: PromptDriver | undefined;
  },
): Promise<PromptAnswer> => {
  const { supplied, runner, io, interactive, yes, cwd, runs, driver } = context;
  if (supplied !== undefined) return resolveDynamicSupplied(prompt, supplied);

  const permission = evaluateRunPermission(runs, prompt.choicesFrom.command);
  if (permission.kind === "denied") {
    throw runNotAllowedError(prompt.choicesFrom.command, permission.allowlist);
  }
  if (permission.kind === "warn" && io !== undefined) {
    io.writeError(`${defaultRunWarning(prompt.choicesFrom.command, permission.allowlist)}\n`);
  }

  const outcome = await runChoicesCommand(runner, prompt.choicesFrom);
  if (outcome.ok) {
    const effective: RecipePrompt = { ...prompt, choices: outcome.choices };
    const def = promptDefaultRaw(effective);
    if (yes || !interactive) {
      if (def.hasDefault) return resolveDefault(effective, def.raw, cwd);
      throw missingAnswer(effective);
    }
    return runInteractivePrompt(effective, io as PromptIO, cwd, driver);
  }

  if (interactive && !yes && io !== undefined)
    return runManualChoiceFallback(prompt, io, outcome.reason, driver);

  const def = promptDefaultRaw(prompt);
  if (def.hasDefault) return resolveDynamicSupplied(prompt, def.raw);
  throw choicesError(prompt, prompt.choicesFrom, outcome);
};

export const collectPrompts = async (options: CollectPromptsOptions): Promise<PromptAnswers> => {
  const { prompts, answers = {}, yes = false, nonInteractive = false, cwd = process.cwd(), io } = options;
  const interactive = !nonInteractive && io !== undefined;
  const driver = options.interactiveDriver;
  const choicesRunner = options.choicesRunner ?? createDefaultChoicesCommandRunner();
  const editorRunner = options.editorRunner ?? createDefaultEditorRunner();

  const resolved: Record<string, PromptAnswer> = {};
  for (const prompt of prompts) {
    const supplied = answers[prompt.name];

    if (isDynamicChoicesPrompt(prompt)) {
      resolved[prompt.name] = await resolveDynamicChoicesPrompt(prompt, {
        supplied,
        runner: choicesRunner,
        io,
        interactive,
        yes,
        cwd,
        runs: options.runs,
        driver,
      });
      continue;
    }

    if (supplied !== undefined) {
      resolved[prompt.name] = await resolveSupplied(prompt, supplied, cwd);
      continue;
    }

    const def = promptDefaultRaw(prompt);

    if (yes || !interactive) {
      if (def.hasDefault) {
        resolved[prompt.name] = await resolveDefault(prompt, def.raw, cwd);
        continue;
      }
      throw missingAnswer(prompt);
    }

    resolved[prompt.name] = await runInteractivePrompt(prompt, io as PromptIO, cwd, driver, editorRunner);
  }
  return resolved;
};

export const parseAnswerFlags = (raw: ReadonlyArray<string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    if (key === "") continue;
    out[key] = entry.slice(eq + 1);
  }
  return out;
};
