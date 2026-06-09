/**
 * Minimal, dependency-free YAML subset parser shared by `ConfigService`
 * (`core/src/services/config.ts`) and the cold-start root resolver
 * (`core/src/config/roots.ts`).
 *
 * This is the **single source of truth** for how `<userConfRoot>/config.yml` is
 * interpreted. `resolveUserDataRoot` runs on the `lando shellenv` fast path
 * (bootstrap `none`, no Effect runtime — spec §8.4 / PRD-02 US-004), so it
 * cannot import `ConfigService` (that module pulls in Effect). Previously
 * `roots.ts` hand-rolled its own line scanner, which diverged from
 * `parseConfigYaml` on duplicate keys, block-then-scalar, indented keys, and
 * YAML `null` — recreating the very `setup` vs `shellenv` PATH mismatch the
 * config.yml layer was added to fix. Both paths now parse with this module so
 * they cannot disagree.
 *
 * This module deliberately imports nothing from `@lando/sdk` (its error barrel
 * pulls Effect) — it throws a plain {@link MinimalYamlError} that callers map to
 * their own error type.
 */

/** Plain (Effect-free) parse failure; callers map it to a domain error. */
export class MinimalYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinimalYamlError";
  }
}

export const parseScalar = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    throw new MinimalYamlError(`Unsupported YAML value: ${trimmed}`);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export const parseMinimalYaml = (text: string): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    const trimmedLine = withoutComment.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) continue;

    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const match = trimmedLine.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (match === null) {
      throw new MinimalYamlError(`Malformed YAML at line ${index + 1}`);
    }

    let current = stack.at(-1);
    while (stack.length > 1 && current !== undefined && indent <= current.indent) {
      stack.pop();
      current = stack.at(-1);
    }

    const parent = stack.at(-1);
    if (parent === undefined) {
      throw new MinimalYamlError(`Malformed YAML at line ${index + 1}`);
    }
    if (indent <= parent.indent) {
      throw new MinimalYamlError(`Malformed YAML indentation at line ${index + 1}`);
    }

    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) {
      throw new MinimalYamlError(`Malformed YAML at line ${index + 1}`);
    }

    if (rawValue.trim() === "") {
      const nested: Record<string, unknown> = {};
      parent.value[key] = nested;
      stack.push({ indent, value: nested });
      continue;
    }

    parent.value[key] = parseScalar(rawValue);
  }

  return root;
};
