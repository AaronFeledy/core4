import { collectSecretEnvValues } from "@lando/redaction/service";

const collectConfigValues = (result: unknown, path = ""): string[] => {
  if (typeof result !== "object" || result === null) return [];
  const tokens: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    const nextPath = path === "" ? key : `${path}.${key}`;
    if (typeof value === "string") {
      tokens.push(
        ...(nextPath.startsWith("tracing.otlp.headers.")
          ? [value]
          : collectSecretEnvValues({ [key]: value })),
      );
    } else tokens.push(...collectConfigValues(value, nextPath));
  }
  return tokens;
};

export const configRedactionTokens = (result: unknown): readonly string[] => {
  if (typeof result !== "object" || result === null) return [];
  const tokens = [
    ...collectConfigValues("config" in result ? result.config : undefined),
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
    const leaf = result.key.split(".").at(-1);
    if (result.key.startsWith("tracing.otlp.headers.")) tokens.push(result.value);
    else if (leaf !== undefined) tokens.push(...collectSecretEnvValues({ [leaf]: result.value }));
  }
  return tokens;
};
