import { ParseResult, Schema } from "effect";

class ComposeDurationParseError extends ParseResult.Type {
  override toString(): string {
    return this.message ?? "Invalid Compose duration";
  }
}

const durationFailure = (literal: string): ParseResult.Type => {
  // The "Landofile service" prefix is load-bearing: core's Landofile validation
  // formatter only surfaces a nested issue's message when it starts with that
  // prefix, otherwise the user sees the bare key path instead of the remediation.
  const message = `Landofile service Compose duration ${JSON.stringify(literal)} is invalid; expected one or more decimal-unit groups such as "30s", "1m30s", or "1h2m3s" (units: ns, us, µs, μs, ms, s, m, h), or bare "0".`;
  return new ComposeDurationParseError(Schema.String.ast, literal, message);
};

const componentSeconds = (decimal: string, unit: string): number | undefined => {
  const value = Number(decimal);
  switch (unit) {
    case "ns":
      return value / 1_000_000_000;
    case "us":
    case "µs":
    case "μs":
      return value / 1_000_000;
    case "ms":
      return value / 1_000;
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    default:
      return undefined;
  }
};

export const parseComposeDuration = (literal: string): number => {
  const value = literal.startsWith("+") ? literal.slice(1) : literal;
  if (value === "0") return 0;

  const componentPattern = /([0-9]+(?:\.[0-9]+)?)(ns|us|µs|μs|ms|s|m|h)/y;
  let cursor = 0;
  let seconds = 0;
  while (cursor < value.length) {
    componentPattern.lastIndex = cursor;
    const match = componentPattern.exec(value);
    if (match === null) throw durationFailure(literal);
    const decimal = match[1];
    if (decimal === undefined) throw durationFailure(literal);
    const component = componentSeconds(decimal, match[2] ?? "");
    if (component === undefined) throw durationFailure(literal);

    seconds += component;
    cursor = componentPattern.lastIndex;
  }

  if (cursor === 0 || cursor !== value.length || !Number.isFinite(seconds)) {
    throw durationFailure(literal);
  }
  return seconds;
};
