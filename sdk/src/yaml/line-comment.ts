export const stripYamlLineComment = (value: string): string => {
  let quote: "'" | '"' | undefined;
  let flowDepth = 0;
  let tokenStart = true;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") index += 1;
      else if (quote === "'" && char === "'" && value[index + 1] === "'") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) return value.slice(0, index);
    if (char !== undefined && /\s/.test(char)) continue;
    if (tokenStart && (char === '"' || char === "'")) {
      quote = char;
      tokenStart = false;
    } else if (tokenStart && (char === "[" || char === "{")) {
      flowDepth += 1;
    } else if (flowDepth > 0 && (char === "]" || char === "}")) {
      flowDepth -= 1;
      tokenStart = false;
    } else if (flowDepth > 0 && (char === "," || char === ":")) {
      tokenStart = true;
    } else {
      tokenStart = false;
    }
  }
  return value;
};
