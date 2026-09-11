import type { ConfigTranslateSecretReference, RecipeSecretDisposition } from "@lando/sdk/schema";

export const secretReference = (
  disposition: RecipeSecretDisposition,
  storedReference: string | undefined,
): ConfigTranslateSecretReference => {
  switch (disposition.kind) {
    case "secret-store":
      if (storedReference === undefined || storedReference.length === 0) {
        throw new RangeError("A stored-secret disposition requires a non-empty reference.");
      }
      return { disposition: "secret-store", reference: storedReference };
    case "init-only":
      switch (disposition.sink.kind) {
        case "stdin":
          return { disposition: "postInit.stdin" };
        case "secretEnv":
          return { disposition: "postInit.secretEnv", name: disposition.sink.name };
        default:
          return disposition.sink satisfies never;
      }
    default:
      return disposition satisfies never;
  }
};

export const containsSecretValue = (raw: readonly string[], value: unknown): boolean => {
  if (typeof value === "string") return raw.some((secret) => value.includes(secret));
  if (Array.isArray(value)) return value.some((item) => containsSecretValue(raw, item));
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).some(
      ([key, item]) => containsSecretValue(raw, key) || containsSecretValue(raw, item),
    )
  );
};
