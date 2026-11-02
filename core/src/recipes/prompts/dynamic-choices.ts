import { RecipeChoicesError, causeMessage } from "@lando/sdk/errors";
import type { PromptAnswer, RecipeChoicesFrom, RecipePrompt, RecipePromptChoice } from "@lando/sdk/schema";
import { defaultRunWarning, evaluateRunPermission, runNotAllowedError } from "../run-allowlist";
import {
  canOmitAnswer,
  missingAnswer,
  promptDefaultRaw,
  resolveDefault,
  validationFail,
} from "./answer-resolution.ts";
import {
  type ChoicesCommandRunner,
  ChoicesParseFailure,
  type ChoicesParseFailureKind,
  parseChoicesOutput,
} from "./choices-command";
import type { PromptDriver } from "./driver";
import {
  renderManualChoiceLine,
  runDriverPrompt,
  runInteractivePrompt,
  tryDriverPrompt,
} from "./interactive.ts";
import type { PromptIO } from "./io";
import { type CoerceResult, enforceMultiSelectBounds, validateText } from "./validation.ts";

export const isDynamicChoicesPrompt = (
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

const runChoicesCommand = async (
  runner: ChoicesCommandRunner,
  choicesFrom: RecipeChoicesFrom,
): Promise<ChoicesOutcome> => {
  let result: Awaited<ReturnType<ChoicesCommandRunner>>;
  try {
    result = await runner({ command: choicesFrom.command, args: choicesFrom.args ?? [] });
  } catch (cause) {
    return { ok: false, kind: "command-failed", reason: `command failed to run: ${causeMessage(cause)}` };
  }
  if (result.exitCode !== 0)
    return {
      ok: false,
      kind: "command-failed",
      reason: `command exited with code ${String(result.exitCode)}`,
      exitCode: result.exitCode,
    };
  try {
    return { ok: true, choices: parseChoicesOutput(result.stdout, choicesFrom.parse) };
  } catch (cause) {
    if (cause instanceof ChoicesParseFailure) return { ok: false, kind: cause.kind, reason: cause.message };
    return { ok: false, kind: "unparseable", reason: causeMessage(cause) };
  }
};

const acceptManualValue = (prompt: RecipePrompt, raw: string): CoerceResult => {
  if (prompt.type === "multiselect") {
    const values = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const bounds = enforceMultiSelectBounds(prompt, values.length);
    if (!bounds.ok) return { ok: false, issue: bounds.issue };
    return { ok: true, value: values };
  }
  return validateText(prompt, raw);
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
  reason: string,
  session: { readonly io: PromptIO; readonly driver: PromptDriver | undefined },
): Promise<PromptAnswer | undefined> => {
  const { io, driver } = session;
  io.writeError(`Could not load choices for "${prompt.name}" (${reason}). Enter the value manually.\n`);
  if (driver !== undefined && io.isTTY) {
    const outcome = await tryDriverPrompt(() =>
      runDriverPrompt(prompt, driver, {
        mode: "manual-choice",
        coerce: (effective) => acceptManualValue(prompt, effective),
      }),
    );
    if (outcome.ok) return outcome.value;
  }
  const def = promptDefaultRaw(prompt);
  while (true) {
    io.write(renderManualChoiceLine(prompt));
    const raw = await io.readLine();
    if (raw === "" && canOmitAnswer(prompt)) return undefined;
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
  if (!result.ok)
    throw validationFail(
      prompt,
      result.issue,
      `Update --answer ${prompt.name}=<value> with a value that satisfies the recipe constraint.`,
    );
  return result.value;
};

export const resolveDynamicChoicesPrompt = async (
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
): Promise<PromptAnswer | undefined> => {
  const { supplied, runner, io, interactive, yes, cwd, runs, driver } = context;
  if (supplied !== undefined) return resolveDynamicSupplied(prompt, supplied);
  const permission = evaluateRunPermission(runs, prompt.choicesFrom.command);
  if (permission.kind === "denied")
    throw runNotAllowedError(prompt.choicesFrom.command, permission.allowlist);
  if (permission.kind === "warn" && io !== undefined)
    io.writeError(`${defaultRunWarning(prompt.choicesFrom.command, permission.allowlist)}\n`);
  const outcome = await runChoicesCommand(runner, prompt.choicesFrom);
  if (outcome.ok) {
    const effective: RecipePrompt = { ...prompt, choices: outcome.choices };
    const def = promptDefaultRaw(effective);
    if (yes || !interactive || io === undefined) {
      if (def.hasDefault) return resolveDefault(effective, def.raw, cwd);
      throw missingAnswer(effective);
    }
    return runInteractivePrompt(effective, { io, cwd, driver });
  }
  if (interactive && !yes && io !== undefined)
    return runManualChoiceFallback(prompt, outcome.reason, { io, driver });
  const def = promptDefaultRaw(prompt);
  if (def.hasDefault) return resolveDynamicSupplied(prompt, def.raw);
  throw choicesError(prompt, prompt.choicesFrom, outcome);
};
