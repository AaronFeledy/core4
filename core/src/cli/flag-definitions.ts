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

export const flagToken = (arg: string): string => {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
};
