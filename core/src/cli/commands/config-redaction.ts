import { collectSecretEnvValues, collectSecretStructuralValues } from "@lando/redaction/service";
import { type ValidationIssuePath, parseValidationIssuePath } from "@lando/sdk/schema";
import { isSecretStructuralName } from "@lando/sdk/secrets";

const collectConfigValues = (
  result: unknown,
  path: ValidationIssuePath = [],
  sensitive = false,
): string[] => {
  if (typeof result === "string") {
    const [root, second, third] = path;
    if (root === "tracing" && second === "otlp" && third === "headers") return [result];
    if (root === "serviceDefaults" && (second === "environment" || second === "labels"))
      return collectSecretEnvValues({ [String(third ?? "")]: result });
    const name = sensitive ? "password" : String(path.at(-1) ?? "");
    return collectSecretStructuralValues({ [name]: result });
  }
  if (typeof result !== "object" || result === null) return [];
  const tokens: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    tokens.push(...collectConfigValues(value, [...path, key], sensitive || isSecretStructuralName(key)));
  }
  return tokens;
};

export const configRedactionTokens = (result: unknown): readonly string[] => {
  if (typeof result !== "object" || result === null) return [];
  const path =
    "key" in result && typeof result.key === "string" ? parseValidationIssuePath(result.key) : undefined;
  return [
    ...collectConfigValues("config" in result ? result.config : undefined),
    ...collectConfigValues("raw" in result ? result.raw : undefined),
    ...collectConfigValues(
      "value" in result ? result.value : undefined,
      path,
      path?.some((part) => typeof part === "string" && isSecretStructuralName(part)),
    ),
  ];
};
