/**
 * The block-mapping key form (`db_password: value`).
 *
 * A block-mapping key has no blank between the name and its colon, and its bare
 * value is the rest of the line because a YAML plain scalar may contain spaces.
 * The key's search carries the line prefix (indentation and an optional `- `
 * list marker), so an open value reports the line start.
 */
import type { SecretConstruct } from "./secret-constructs.ts";
import { isStructuralRun, keptSpan, maskedSpan, openQuotedConstruct } from "./secret-constructs.ts";
import { type ClosedValue, isAssignmentStop, isBlank, readQuoted, readYamlScalar } from "./secret-lexeme.ts";
import {
  YAML_TYPED_LITERAL,
  isQuotedOrBarePublishedDefault,
  keepsReference,
  sentinelInQuotesOf,
} from "./secret-value-mask.ts";

const COLON = 58;
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const DASH = 45;

/** The start of a block-mapping key's line prefix (indentation and optional `- `). */
export const yamlPrefixStart = (text: string, runStart: number): number | undefined => {
  let start = runStart;
  while (start > 0 && isBlank(text.charCodeAt(start - 1))) start -= 1;
  if (start > 0 && text.charCodeAt(start - 1) === DASH) {
    if (start === runStart) return undefined;
    start -= 1;
    while (start > 0 && isBlank(text.charCodeAt(start - 1))) start -= 1;
  }
  if (start === 0) return start;
  const previous = text.charCodeAt(start - 1);
  return previous === NEWLINE || previous === CARRIAGE_RETURN ? start : undefined;
};

/**
 * A block-mapping key at the start of a line. A bare YAML value is the rest of
 * the line, because a plain scalar may contain spaces.
 */
export const matchYaml = (
  text: string,
  runEnd: number,
  name: string,
  prefixStart: number,
): SecretConstruct | undefined => {
  // A block-mapping key has no blank between the name and its colon; check that
  // before the recognizer so prose triggers cost one character compare.
  const separator = runEnd;
  if (text.charCodeAt(separator) !== COLON || !isStructuralRun(name)) return undefined;
  let valueStart = separator + 1;
  let blanks = 0;
  while (isBlank(text.charCodeAt(valueStart))) {
    valueStart += 1;
    blanks += 1;
  }
  if (blanks === 0) return undefined;
  const quoted = readQuoted(text, valueStart);
  let value: ClosedValue | undefined;
  if (quoted === undefined) {
    value = readYamlScalar(text, valueStart);
  } else if ("open" in quoted) {
    return openQuotedConstruct(text, prefixStart, valueStart, true);
  } else {
    value = quoted;
  }
  if (value === undefined) return undefined;
  const raw = text.slice(valueStart, value.end);
  if (
    YAML_TYPED_LITERAL.test(raw) ||
    isQuotedOrBarePublishedDefault(raw) ||
    keepsReference(raw, text.charCodeAt(value.end), isAssignmentStop)
  )
    return keptSpan(prefixStart, value.end);
  return maskedSpan(prefixStart, valueStart, value.end, sentinelInQuotesOf(raw, "", ""));
};
