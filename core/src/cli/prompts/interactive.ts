/**
 * Driver-first helpers for ad-hoc (non-recipe) confirmations and single
 * selections, so command surfaces — recipe init, plugin trust, and setup
 * provider choice — share one interactive prompt visual treatment.
 *
 * Each helper returns `undefined` when no rich driver is active (or the driver
 * declines/fails), letting the caller keep its existing line-based prompt
 * byte-for-byte. A {@link PromptCancelledError} always propagates so the
 * command aborts on Ctrl-C / Esc.
 */

import type { RecipePrompt } from "@lando/sdk/schema";

import { PromptCancelledError, type PromptDriver } from "../../recipes/prompts/driver.ts";
import type { PromptIO } from "../../recipes/prompts/index.ts";

const AFFIRMATIVE = /^(?:y|yes|true|1|on)$/iu;

export interface DriverConfirmSpec {
  readonly message: string;
  readonly default?: boolean;
  readonly name?: string;
}

export const tryDriverConfirm = async (
  driver: PromptDriver | undefined,
  io: PromptIO,
  spec: DriverConfirmSpec,
): Promise<boolean | undefined> => {
  if (driver === undefined || !io.isTTY) return undefined;
  const prompt = {
    name: spec.name ?? "confirm",
    type: "confirm",
    message: spec.message,
    ...(spec.default === undefined ? {} : { default: spec.default }),
  } as RecipePrompt;
  try {
    const raw = await driver.readRaw({ prompt, mode: "confirm" });
    return AFFIRMATIVE.test(raw.trim());
  } catch (cause) {
    if (cause instanceof PromptCancelledError) throw cause;
    return undefined;
  }
};

export interface DriverSelectChoice {
  readonly value: string;
  readonly label?: string;
}

export interface DriverSelectSpec {
  readonly message: string;
  readonly choices: ReadonlyArray<DriverSelectChoice>;
  readonly default?: string;
  readonly name?: string;
}

export const tryDriverSelect = async (
  driver: PromptDriver | undefined,
  io: PromptIO,
  spec: DriverSelectSpec,
): Promise<string | undefined> => {
  if (driver === undefined || !io.isTTY || spec.choices.length === 0) return undefined;
  const choices = spec.choices.map((choice) =>
    choice.label === undefined ? { value: choice.value } : { value: choice.value, label: choice.label },
  );
  const prompt = {
    name: spec.name ?? "select",
    type: "select",
    message: spec.message,
    choices,
    ...(spec.default === undefined ? {} : { default: spec.default }),
  } as RecipePrompt;
  try {
    const raw = await driver.readRaw({ prompt, mode: "normal", choices });
    const index = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(index) || index < 1 || index > choices.length) return undefined;
    return choices[index - 1]?.value;
  } catch (cause) {
    if (cause instanceof PromptCancelledError) throw cause;
    return undefined;
  }
};
