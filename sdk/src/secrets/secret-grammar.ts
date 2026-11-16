/**
 * The construct that starts at one position.
 *
 * One position can satisfy several forms at once (`db_password: "x"` is both a
 * colon assignment and a block-mapping key), so this module is the single place
 * that decides their order. The value views and every trigger-composed reader
 * call it, so a construct is classified the same way wherever it is reached.
 */
import { type SecretConstruct, matchAssignment, matchMember } from "./secret-constructs.ts";
import { isNameCode, nameRunEnd } from "./secret-lexeme.ts";
import { matchYaml, yamlPrefixStart } from "./secret-yaml-key.ts";

/** A grammar construct starting exactly at `at` (used inside value views). */
export const grammarAt = (text: string, at: number, knownRunEnd?: number): SecretConstruct | undefined => {
  if (
    knownRunEnd === undefined &&
    (!isNameCode(text.charCodeAt(at)) || (at > 0 && isNameCode(text.charCodeAt(at - 1))))
  )
    return undefined;
  const runEnd = knownRunEnd ?? nameRunEnd(text, at);
  const name = text.slice(at, runEnd);
  const member = matchMember(text, at, runEnd, name);
  if (member !== undefined) return member;
  const prefix = yamlPrefixStart(text, at);
  if (prefix !== undefined) {
    const yaml = matchYaml(text, runEnd, name, prefix);
    if (yaml !== undefined) return yaml;
  }
  return matchAssignment(text, at, runEnd, name);
};
