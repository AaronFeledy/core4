import { isLegacyTagged } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { serviceCursor } from "./claims.ts";
import type { Lando3Path } from "./contract.ts";
import { type ServiceLoweringContext, hasPlainObjectPrototype } from "./lowering-contract.ts";

export type AssignmentPolicy = "environment" | "labels" | "build-args";
export type AssignmentEntry = {
  readonly name: string;
  readonly value: string;
  /** Prefix-local effective coordinates, used only by the claim ledger. */
  readonly cell: Lando3Path;
  /** Original authored coordinates, including list indices. */
  readonly relative: Lando3Path;
};
type AssignmentLocation = {
  readonly ctx: ServiceLoweringContext;
  readonly relative: Lando3Path;
};
type PendingAssignment = Omit<AssignmentEntry, "value"> & { readonly value: string | undefined };

/** Never consults the host environment, including for bare names and null values. */
export const normalizeAssignments = (
  value: unknown,
  location: AssignmentLocation,
  policy: AssignmentPolicy,
) => {
  const { ctx, relative } = location;
  const entries = new Map<string, PendingAssignment>();
  const superseded: PendingAssignment[] = [];
  const invalid: Lando3Path[] = [];
  const add = (name: string, item: unknown, cell: Lando3Path): void => {
    if (name.length === 0) {
      invalid.push(cell);
      return;
    }
    const previous = entries.get(name);
    if (previous !== undefined) superseded.push(previous);
    entries.delete(name);
    entries.set(name, {
      name,
      value: ["string", "number", "boolean"].includes(typeof item) ? String(item) : undefined,
      cell,
      relative: ctx.occurrenceAt(cell)?.keyPath.slice(ctx.keyPath.length) ?? cell,
    });
  };
  if (isLegacyTagged(value)) invalid.push(relative);
  else if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      const cell = [...relative, index];
      if (typeof item !== "string") {
        invalid.push(cell);
        return;
      }
      const separator = item.indexOf("=");
      if (separator < 0) {
        if (policy === "labels") add(item, "", cell);
        else add(item, undefined, cell);
      } else add(item.slice(0, separator), item.slice(separator + 1), cell);
    });
  } else if (hasPlainObjectPrototype(value)) {
    for (const [name, item] of Object.entries(value)) {
      add(name, item, [...relative, name]);
    }
  } else if (value !== undefined) invalid.push(relative);
  const assignments = [...entries.values()];
  return {
    assignments,
    entries: assignments.filter((entry): entry is AssignmentEntry => entry.value !== undefined),
    superseded,
    invalid: [
      ...invalid,
      ...assignments.filter((entry) => entry.value === undefined).map(({ cell }) => cell),
    ],
  };
};

export const lowerAssignments = (value: unknown, location: AssignmentLocation, policy: AssignmentPolicy) => {
  const normalized = normalizeAssignments(value, location, policy);
  const cursor = serviceCursor(value, location.ctx, location.relative);
  cursor.take(location.relative);
  for (const entry of [...normalized.entries, ...normalized.superseded]) cursor.mapTo(entry.cell);
  const diagnostics: ConfigTranslateDiagnostic[] = normalized.invalid.map((cell) =>
    cursor.dropTree(
      cell,
      "This entry requires an explicit scalar value; inherited host values are not converted.",
      "Supply an explicit KEY=value assignment or scalar mapping value before converting.",
    ),
  );
  return { ...normalized, diagnostics };
};
