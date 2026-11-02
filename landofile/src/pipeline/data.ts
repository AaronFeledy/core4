import { LandofileValidationError } from "@lando/sdk/errors";
import { isLandofileOverride, isLandofileReset, isPlainRecord } from "@lando/sdk/landofile";
import { Effect } from "effect";
import type { AuthoredOrigin } from "./prepare.ts";

export const checkDocumentData = (value: unknown, source: Omit<AuthoredOrigin, "path">) =>
  Effect.try({
    try: () => {
      let nodes = 0;
      const visit = (input: unknown, path: readonly (string | number)[]): void => {
        const fail = (message: string): never => {
          throw new LandofileValidationError({
            file: source.file,
            message,
            remediation: "Use a bounded plain-data Landofile mapping.",
            issues: [{ path, message, source: { ...source, path } }],
          });
        };
        if (++nodes > 100000 || path.length > 64) fail("Landofile exceeds the document budget.");
        if (isLandofileReset(input)) return;
        if (isLandofileOverride(input)) {
          visit(input.value, path);
          return;
        }
        if (Array.isArray(input)) {
          input.forEach((entry, index) => visit(entry, [...path, index]));
          return;
        }
        if (isPlainRecord(input)) {
          for (const [key, entry] of Object.entries(input)) visit(entry, [...path, key]);
          return;
        }
        if (
          input === null ||
          input === undefined ||
          typeof input === "string" ||
          typeof input === "boolean" ||
          (typeof input === "number" && Number.isFinite(input))
        )
          return;
        fail("Landofile values must be finite plain data.");
      };
      visit(value, []);
    },
    catch: (cause) =>
      cause instanceof LandofileValidationError
        ? cause
        : new LandofileValidationError({
            file: source.file,
            message: "Landofile data could not be inspected.",
            remediation: "Use a bounded plain-data Landofile mapping.",
            issues: [],
          }),
  });
