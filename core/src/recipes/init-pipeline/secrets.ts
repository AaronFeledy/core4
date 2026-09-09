import type { ConfigTranslateSecretReference, RecipeSecretDisposition } from "@lando/sdk/schema";

export const secretReference = (disposition: RecipeSecretDisposition): ConfigTranslateSecretReference => {
  switch (disposition.kind) {
    case "secret-store":
      return { disposition: "secret-store", reference: disposition.field };
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
