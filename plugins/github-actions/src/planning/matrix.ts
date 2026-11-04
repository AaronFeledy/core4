import { Effect } from "effect";
import type { LanguageSource } from "../language/errors.ts";
import { expressionDataFromUnknownSync } from "../language/expressions.ts";
import { planningError } from "./errors.ts";

export type MatrixValue =
  | null
  | boolean
  | number
  | string
  | readonly MatrixValue[]
  | { readonly [key: string]: MatrixValue };
export type MatrixLeg = Readonly<Record<string, MatrixValue>>;
export interface MatrixLimits {
  readonly maxJobs?: number;
  readonly maxWork?: number;
  readonly source?: LanguageSource;
}
/** Finite JSON admission occurs before product allocation, including excluded combinations. */
export const expandMatrixWithBudget = (input: unknown, limits: MatrixLimits = {}) =>
  Effect.try({
    try: (): { readonly legs: readonly MatrixLeg[]; readonly budgetUsed: number } => {
      const fail = (code: Parameters<typeof planningError>[0]) => planningError(code, limits.source);
      const maxJobs = limits.maxJobs ?? 256;
      const maxWork = limits.maxWork ?? 65536;
      if (
        !Number.isInteger(maxJobs) ||
        maxJobs < 1 ||
        maxJobs > 256 ||
        !Number.isInteger(maxWork) ||
        maxWork < 1 ||
        maxWork > 65536
      )
        throw fail("matrix-limit");
      let work = 0;
      const charge = (units = 1): void => {
        work += units;
        if (work > maxWork) throw fail("matrix-work-limit");
      };
      const equal = (a: MatrixValue, b: MatrixValue): boolean => {
        charge();
        if (a === b) return true;
        if (Array.isArray(a) && Array.isArray(b))
          return a.length === b.length && a.every((value, index) => equal(value, b[index] as MatrixValue));
        if (
          a !== null &&
          b !== null &&
          typeof a === "object" &&
          typeof b === "object" &&
          !Array.isArray(a) &&
          !Array.isArray(b)
        ) {
          const left = a as Record<string, MatrixValue>;
          const right = b as Record<string, MatrixValue>;
          const keys = Object.keys(left);
          const rightKeys = Object.keys(right);
          charge(keys.length + rightKeys.length);
          return (
            keys.length === rightKeys.length &&
            keys.every((key) => {
              charge();
              return Object.hasOwn(right, key) && equal(left[key] as MatrixValue, right[key] as MatrixValue);
            })
          );
        }
        return false;
      };

      try {
        expressionDataFromUnknownSync(input, {
          limits: { valueNodes: 10000, valueBytes: 262144, valueDepth: 20 },
        });
      } catch {
        throw fail("matrix-input-limit");
      }
      const visit = (value: unknown): void => {
        if (typeof value === "string" && value.length > 16384) throw fail("matrix-input-limit");
        if (value !== null && typeof value === "object") {
          if (Array.isArray(value)) {
            if (value.length > 256) throw fail("matrix-input-limit");
            for (const child of value) visit(child);
          } else {
            const entries = Object.entries(value);
            if (entries.length > 256) throw fail("matrix-input-limit");
            for (const [key, child] of entries) {
              if (key.length > 256) throw fail("matrix-input-limit");
              visit(child);
            }
          }
        }
      };
      visit(input);
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw fail("matrix-invalid");
      const matrix = input as Record<string, MatrixValue>;
      const axes = Object.entries(matrix).filter(([key]) => key !== "include" && key !== "exclude");
      let product = 1;
      for (const [, values] of axes) {
        if (!Array.isArray(values) || values.length === 0) throw fail("matrix-axis-invalid");
        if (product > Math.floor(maxJobs / values.length)) throw fail("matrix-limit");
        product *= values.length;
      }
      const filters = (key: string): Record<string, MatrixValue>[] => {
        const value = matrix[key];
        if (value === undefined) return [];
        if (!Array.isArray(value)) throw fail("matrix-filter-invalid");
        return value.map((item) => {
          if (item === null || typeof item !== "object" || Array.isArray(item))
            throw fail("matrix-filter-invalid");
          return item as Record<string, MatrixValue>;
        });
      };
      const includes = filters("include");
      const excludes = filters("exclude");
      const axisNames = new Set(axes.map(([key]) => key));
      for (const filter of excludes)
        for (const key of Object.keys(filter)) if (!axisNames.has(key)) throw fail("matrix-filter-invalid");
      if (product * (includes.length + excludes.length + axes.length + 1) > maxWork)
        throw fail("matrix-work-limit");
      let originals: Record<string, MatrixValue>[] = axes.length === 0 ? [] : [{}];
      for (const [key, values] of axes)
        originals = originals.flatMap((row) =>
          (values as readonly MatrixValue[]).map((value) => {
            charge(Object.keys(row).length + 1);
            return { ...row, [key]: value };
          }),
        );
      const retained = originals.filter(
        (row) =>
          !excludes.some((filter) =>
            Object.entries(filter).every(([key, value]) => equal(row[key] as MatrixValue, value)),
          ),
      );
      const augmented = retained.map((row) => ({ ...row }));
      const standalone: Record<string, MatrixValue>[] = [];
      for (const include of includes) {
        let matched = false;
        retained.forEach((original, index) => {
          if (
            Object.entries(include).every(
              ([key, value]) => !axisNames.has(key) || equal(original[key] as MatrixValue, value),
            )
          ) {
            charge(Object.keys(augmented[index] ?? {}).length + Object.keys(include).length);
            augmented[index] = { ...augmented[index], ...include };
            matched = true;
          }
        });
        if (!matched) standalone.push({ ...include });
        if (augmented.length + standalone.length > maxJobs) throw fail("matrix-limit");
      }
      if (axes.length === 0 && includes.length === 0) throw fail("matrix-axis-invalid");
      const legs = [...augmented, ...standalone];
      return { legs, budgetUsed: Math.max(axes.length === 0 ? 0 : product, legs.length) };
    },
    catch: (error) =>
      error instanceof Error && "_tag" in error && error._tag === "PlanningError"
        ? (error as ReturnType<typeof planningError>)
        : planningError("matrix-invalid", limits.source),
  });

export const expandMatrix = (input: unknown, limits: MatrixLimits = {}) =>
  expandMatrixWithBudget(input, limits).pipe(Effect.map((result) => result.legs));
