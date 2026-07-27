import { ParseResult, Schema } from "effect";

const byteSizeFailure = (literal: string): ParseResult.Type => {
  // The "Landofile service" prefix is load-bearing: core's Landofile validation
  // formatter only surfaces a nested issue's message when it starts with that
  // prefix, otherwise the user sees the bare key path instead of the remediation.
  const message =
    'Landofile service Compose byte size is invalid; expected an integer with an optional unit such as "64m", "1gb", or "134217728" (units: b, k, m, g, kb, mb, gb).';
  return new ParseResult.Type(Schema.String.ast, literal, message);
};

const unitMultiplier = (unitLetter: string): number | undefined => {
  switch (unitLetter) {
    case "":
      return 1;
    case "k":
      return 1024;
    case "m":
      return 1024 ** 2;
    case "g":
      return 1024 ** 3;
    case "t":
      return 1024 ** 4;
    case "p":
      return 1024 ** 5;
    default:
      return undefined;
  }
};

// Mirrors docker/go-units RAMInBytes: ^(\d+(\.\d+)*) ?([kKmMgGtTpP])?[iI]?[bB]?$
const byteSizePattern = /^(\d+(?:\.\d+)*) ?([kmgtp])?i?b?$/i;

export const parseComposeByteSize = (literal: string): number => {
  const match = byteSizePattern.exec(literal);
  if (match === null) throw byteSizeFailure(literal);

  const decimal = match[1];
  if (decimal === undefined) throw byteSizeFailure(literal);

  const multiplier = unitMultiplier((match[2] ?? "").toLowerCase());
  if (multiplier === undefined) throw byteSizeFailure(literal);

  const bytes = Math.trunc(Number(decimal) * multiplier);
  if (!Number.isFinite(bytes)) throw byteSizeFailure(literal);
  return bytes;
};
