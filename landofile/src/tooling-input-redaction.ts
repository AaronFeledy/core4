import type { ToolingInputDeclaration, ToolingInvocationInput } from "@lando/sdk/schema";

const strings = (value: unknown): readonly string[] => {
  const pending = [value];
  const seen = new WeakSet<object>();
  const values: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") values.push(current);
    else if (current !== null && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      const nested = Object.values(current);
      for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index]);
    }
  }
  return values;
};

export const toolingInputRedactionTokens = (
  declarations: readonly ToolingInputDeclaration[],
  invocation: ToolingInvocationInput,
): readonly string[] => {
  const tokens: string[] = [];
  for (const declaration of declarations) {
    switch (invocation._tag) {
      case "NamedMaps":
        for (const group of ["flags", "args"] as const)
          for (const field of declaration[group])
            if (field.sensitive && Object.hasOwn(invocation[group], field.name))
              tokens.push(...strings(invocation[group][field.name]));
        break;
      case "RawArgv": {
        let positional = 0;
        let parsingFlags = true;
        for (let index = 0; index < invocation.argv.length; index++) {
          const token = invocation.argv[index];
          if (token === undefined) break;
          if (parsingFlags && token === "--") {
            parsingFlags = false;
            continue;
          }
          if (parsingFlags && token.startsWith("-") && token !== "-") {
            const long = token.startsWith("--");
            const option = token.slice(long ? 2 : 1);
            const equals = option.indexOf("=");
            const key = equals < 0 ? option : option.slice(0, equals);
            const flag = declaration.flags.find((field) => (long ? field.name === key : field.alias === key));
            if (flag?.sensitive && (!flag.boolean || equals >= 0)) {
              const value = equals < 0 ? invocation.argv[index + 1] : option.slice(equals + 1);
              // Boolean switches have no secret string value, but malformed payloads still need protection.
              if (value !== undefined && (!flag.boolean || (value !== "true" && value !== "false")))
                tokens.push(value);
            }
            if (flag !== undefined && !flag.boolean && equals < 0) index++;
          } else {
            if (declaration.args[positional]?.sensitive) tokens.push(token);
            positional++;
          }
        }
        break;
      }
      default:
        return invocation satisfies never;
    }
  }
  return [...new Set(tokens.filter((token) => token.length > 0))];
};
