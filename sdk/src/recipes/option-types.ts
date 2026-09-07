import { Either, Schema } from "effect";
import { RecipeDecomposeError } from "../errors/recipe.ts";
import { RecipeOptionValue, type RecipeSourceKind } from "../schema/recipe-identity.ts";
import type { RecipeOptionType } from "../schema/recipe-snapshot.ts";
import type { RecipeManifest } from "../schema/recipe.ts";
import { validateSnapshotTemplate } from "./snapshot-template.ts";

/**
 * Match a value against the closed serializable option-descriptor vocabulary.
 * Invalid regular-expression sources are unsupported rather than thrown errors;
 * numeric options must be finite and optional descriptors alone accept absence.
 */
export const optionValueMatchesDescriptor = (descriptor: RecipeOptionType, value: unknown): boolean => {
  switch (descriptor.kind) {
    case "string": {
      if (
        typeof value !== "string" ||
        value.length < (descriptor.minLength ?? 0) ||
        value.length > (descriptor.maxLength ?? Number.POSITIVE_INFINITY)
      )
        return false;
      if (descriptor.pattern === undefined) return true;
      try {
        return new RegExp(descriptor.pattern).test(value);
      } catch (error) {
        if (error instanceof SyntaxError) return false;
        throw error;
      }
    }
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= (descriptor.min ?? Number.NEGATIVE_INFINITY) &&
        value <= (descriptor.max ?? Number.POSITIVE_INFINITY) &&
        (!descriptor.integer || Number.isInteger(value))
      );
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && descriptor.values.includes(value);
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= (descriptor.minItems ?? 0) &&
        value.length <= (descriptor.maxItems ?? Number.POSITIVE_INFINITY) &&
        value.every((item: unknown) => optionValueMatchesDescriptor(descriptor.items, item))
      );
    case "optional":
      return value === undefined || optionValueMatchesDescriptor(descriptor.inner, value);
    default:
      return descriptor satisfies never;
  }
};

/**
 * Merge defaults below answers and reject undeclared, missing, or mistyped options.
 * Errors identify the option path without copying its value. This standalone
 * validator has no producer coordinate, so its error recipeId is the empty string.
 */
export const validateOptionValues = (
  optionTypes: Readonly<Record<string, RecipeOptionType>>,
  defaults: Readonly<Record<string, RecipeOptionValue>>,
  values: Readonly<Record<string, unknown>>,
): Either.Either<Record<string, RecipeOptionValue>, RecipeDecomposeError> => {
  const merged = { ...defaults, ...values };
  const fail = (path: string, reason: "unsupported-option" | "option-type") =>
    Either.left(
      new RecipeDecomposeError({
        recipeId: "",
        path,
        reason,
        message: `Invalid recipe option (${reason}).`,
        remediation: "Supply only declared options with values matching their descriptors.",
      }),
    );
  for (const name of Object.keys(merged))
    if (!Object.hasOwn(optionTypes, name)) return fail(name, "unsupported-option");
  const result: Record<string, RecipeOptionValue> = {};
  for (const [name, descriptor] of Object.entries(optionTypes)) {
    const value = Object.hasOwn(merged, name) ? merged[name] : undefined;
    if (!optionValueMatchesDescriptor(descriptor, value)) return fail(name, "option-type");
    if (value === undefined) continue;
    if (!Schema.is(RecipeOptionValue)(value)) return fail(name, "option-type");
    Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return Either.right(result);
};

/**
 * Determine whether ordinary init metadata also supports declarative migration.
 * Local programmatic recipes remain valid for init when no snapshot is supplied.
 * Dynamic choices cannot describe a closed historical option vocabulary.
 */
export const recipeMigratability = (
  manifest: RecipeManifest,
  sourceKind: RecipeSourceKind,
):
  | { readonly status: "migratable" }
  | {
      readonly status: "nonmigratable";
      readonly reason:
        | "missing-snapshot"
        | "local-programmatic-without-snapshot"
        | "unsupported-option-type"
        | "invalid-template";
    } => {
  if (manifest.snapshot === undefined)
    return {
      status: "nonmigratable",
      reason: sourceKind === "local" ? "local-programmatic-without-snapshot" : "missing-snapshot",
    };
  if (manifest.prompts?.some((prompt) => prompt.choicesFrom !== undefined))
    return { status: "nonmigratable", reason: "unsupported-option-type" };
  if (Either.isLeft(validateSnapshotTemplate(manifest.id, manifest.snapshot.template)))
    return { status: "nonmigratable", reason: "invalid-template" };
  return { status: "migratable" };
};
