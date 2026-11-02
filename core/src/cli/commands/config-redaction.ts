import { collectSecretEnvValues, collectSecretStructuralValues } from "@lando/redaction/service";
import { isSecretStructuralName } from "@lando/sdk/secrets";

const collectConfigValues = (result: unknown, path = "", sensitive = false): string[] => {
  if (typeof result === "string") {
    if (path === "tracing.otlp.headers" || path.startsWith("tracing.otlp.headers.")) return [result];
    const [root, ...rest] = path.split(".");
    if (root === "appEnv" || root === "appLabels")
      return collectSecretEnvValues({ [rest.join(".")]: result });
    // Under a secret-named ancestor every leaf is sensitive, so classify it as a password field.
    const name = sensitive ? "password" : (path.split(".").at(-1) ?? "");
    return collectSecretStructuralValues({ [name]: result });
  }
  if (typeof result !== "object" || result === null) return [];
  const tokens: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    const nextPath = path === "" ? key : `${path}.${key}`;
    tokens.push(...collectConfigValues(value, nextPath, sensitive || isSecretStructuralName(key)));
  }
  return tokens;
};

export const configRedactionTokens = (result: unknown): readonly string[] => {
  if (typeof result !== "object" || result === null) return [];
  const tokens = [
    ...collectConfigValues("config" in result ? result.config : undefined),
    ...collectConfigValues("raw" in result ? result.raw : undefined),
    ...collectConfigValues(
      "value" in result ? result.value : undefined,
      "key" in result && typeof result.key === "string" ? result.key : "",
    ),
  ];
  // A set result carries a dot-path beside a scalar rather than its enclosing map.
  if (
    "key" in result &&
    typeof result.key === "string" &&
    "value" in result &&
    typeof result.value === "string"
  ) {
    tokens.push(...collectConfigValues(result.value, result.key));
  }
  return tokens;
};
