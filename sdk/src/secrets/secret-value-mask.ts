/**
 * Masking decisions shared by the scanner's grammar and value views.
 *
 * A completed value is masked unless it is already a credential reference or a
 * published development default: a complete environment/secret reference at a
 * verified terminator, and the published defaults, stay readable. The colon
 * forms keep a value's own quoting (and escaped-JSON backslash run) around the
 * sentinel so a masked document still parses the value as a string, while a
 * bare value takes the fallback quoting of its grammar.
 */
import { isCompleteEnvReference } from "./env-placeholder.ts";
import { isPublicDefaultCredential } from "./public-default-credentials.ts";
import { SENTINEL, type StopCode, countBackslashes, isQuoteCode } from "./secret-lexeme.ts";

/** Bare member values spelled as a JSON/Python boolean or null are typed syntax, not strings. */
export const MEMBER_TYPED_LITERAL = /^(?:true|false|null)$/iu;
/** YAML also spells null as `~`. */
export const YAML_TYPED_LITERAL = /^(?:true|false|null|~)$/iu;

/** A complete environment or secret reference at a verified terminator stays readable. */
export const keepsReference = (value: string, terminatorCode: number, isStop: StopCode): boolean =>
  (Number.isNaN(terminatorCode) || isStop(terminatorCode)) && isCompleteEnvReference(value);

/** Published default credentials keep their whole assignment, quoted or bare. */
export const isQuotedOrBarePublishedDefault = (value: string): boolean => {
  if (isPublicDefaultCredential(value)) return true;
  const quote = value[0];
  if (value.length < 2 || (quote !== '"' && quote !== "'") || value.at(-1) !== quote) return false;
  return isPublicDefaultCredential(value.slice(1, -1));
};

/** A value keeps its own quoting (and escaped-JSON backslash run) around the sentinel. */
export const sentinelInQuotesOf = (value: string, fallbackRun: string, fallbackQuote: string): string => {
  const run = countBackslashes(value, 0);
  const quote = value.charCodeAt(run);
  if (!isQuoteCode(quote)) return `${fallbackRun}${fallbackQuote}${SENTINEL}${fallbackRun}${fallbackQuote}`;
  const opener = value.slice(0, run + 1);
  return `${opener}${SENTINEL}${opener}`;
};

/** Mask an unresolved construct in complete text: its value is unproven to the end. */
export const openConstructReplacement = (value: string, keepsValueQuoting: boolean): string => {
  return keepsValueQuoting ? sentinelInQuotesOf(value, "", "") : SENTINEL;
};
