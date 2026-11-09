type FlagDefinition = {
  readonly name: string;
  readonly boolean: boolean;
  readonly integer: boolean;
  readonly min: number | undefined;
  readonly multiple: boolean;
  readonly options: ReadonlyArray<string>;
};

export const flagDefinitionsByToken = (
  definitions: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, FlagDefinition> => {
  const byToken = new Map<string, FlagDefinition>();
  for (const [name, candidate] of Object.entries(definitions)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const definition = {
      name,
      boolean: "type" in candidate && candidate.type === "boolean",
      integer: "valueType" in candidate && candidate.valueType === "integer",
      min: "min" in candidate && typeof candidate.min === "number" ? candidate.min : undefined,
      multiple: "multiple" in candidate && candidate.multiple === true,
      options:
        "options" in candidate && Array.isArray(candidate.options)
          ? candidate.options.filter((option): option is string => typeof option === "string")
          : [],
    };
    byToken.set(`--${name}`, definition);
    if ("char" in candidate && typeof candidate.char === "string") {
      byToken.set(`-${candidate.char}`, definition);
    }
    if ("aliases" in candidate && Array.isArray(candidate.aliases)) {
      for (const alias of candidate.aliases) {
        if (typeof alias === "string") byToken.set(`--${alias}`, definition);
      }
    }
  }
  return byToken;
};

export const normalizeCliFlagTokens = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> => {
  const byToken = flagDefinitionsByToken(definitions);
  const normalized: string[] = [];
  let optionsEnded = false;

  for (const arg of argv) {
    if (optionsEnded || arg === "--" || !arg.startsWith("-") || arg.startsWith("--") || arg.length <= 2) {
      normalized.push(arg);
      if (arg === "--") optionsEnded = true;
      continue;
    }

    const expanded: string[] = [];
    const bundle = arg.slice(1);
    let offset = 0;
    let recognized = true;
    while (offset < bundle.length) {
      const token = `-${bundle[offset]}`;
      const definition = byToken.get(token);
      if (definition === undefined) {
        recognized = false;
        break;
      }
      expanded.push(token);
      offset += 1;
      if (definition.boolean) {
        const attached = bundle.slice(offset);
        const nextToken = attached.length === 0 ? undefined : byToken.get(`-${attached[0]}`);
        if (attached.length > 0 && nextToken === undefined) {
          expanded[expanded.length - 1] =
            `${token}=${attached.startsWith("=") ? attached.slice(1) : attached}`;
          offset = bundle.length;
        }
        continue;
      }

      const attached = bundle.slice(offset);
      if (attached.length > 0) expanded.push(attached.startsWith("=") ? attached.slice(1) : attached);
      offset = bundle.length;
    }
    normalized.push(...(recognized ? expanded : [arg]));
  }

  return normalized;
};
