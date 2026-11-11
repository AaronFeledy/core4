import { parseExpressionEither } from "@lando/sdk/expressions";
import { isLandofileReset, isPlainRecord } from "@lando/sdk/landofile";
import type { ValidationFix, ValidationFixEdit, ValidationIssuePath } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Result } from "effect";
import { valueAtPath } from "./validation-suggestions.ts";

let fixRedactor: ReturnType<typeof createRedactor> | undefined;

export const secretReferenceFix = (input: {
  readonly document: unknown;
  readonly value: string;
  readonly path: ValidationIssuePath;
  readonly references: readonly string[];
  readonly names: ReadonlyMap<string, string>;
  readonly bindingParent: ValidationIssuePath;
  readonly shorthand: boolean;
}): ValidationFix | undefined => {
  if (input.document === undefined) return undefined;
  // A here-document body and a command substitution each have their own quoting,
  // which the single-pass tracker below does not follow.
  if (/<<|\$\(|`/.test(input.value)) return undefined;
  // An escaped reference is literal text, not a variable mention, so blank every
  // form before looking for a chosen name the command already uses.
  const withoutReferences = input.value.replace(/\$\{secret:[^}]+\}/g, "");
  const collides = [...input.names.values()].some((name) =>
    new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(withoutReferences),
  );
  if (collides) return undefined;
  let replacements = 0;
  let cursor = 0;
  let quote: "'" | '"' | undefined;
  let shellSafe = true;
  const replacement = input.value.replace(
    /(?<!\$)\$\{secret:([^}]+)\}/g,
    (text, reference: string, offset: number) => {
      const name = input.names.get(reference);
      if (name === undefined) return text;
      // Track authored shell quoting, not the expression parser's interpolation grammar.
      while (cursor < offset) {
        const char = input.value[cursor];
        if (char === "\\" && quote !== "'") cursor += 2;
        else if (quote === undefined && char === "#") {
          // Without tokenizing the shell, an unquoted # may start a comment.
          shellSafe = false;
          const newline = input.value.indexOf("\n", cursor);
          cursor = newline < 0 ? input.value.length : newline + 1;
        } else {
          if (char === quote) quote = undefined;
          else if (quote === undefined && (char === "'" || char === '"')) quote = char;
          cursor++;
        }
      }
      // A container shell splits and globs an unquoted expansion, so an unquoted
      // reference becomes the quoted form; the closing quote also ends the name.
      const doubleQuoted = quote === '"';
      // The shell removes a backslash-newline before it expands a name, so look
      // past continuations for the character that would extend or end it.
      let next = offset + text.length;
      while (input.value[next] === "\\" && input.value[next + 1] === "\n") next += 2;
      if (
        quote === "'" ||
        input.value[offset - 1] === "\\" ||
        (doubleQuoted && /^[A-Za-z0-9_]/.test(input.value.slice(next)))
      )
        shellSafe = false;
      cursor = offset + text.length;
      replacements++;
      return doubleQuoted ? `$${name}` : `"$${name}"`;
    },
  );
  const parsed = parseExpressionEither(replacement, {
    filePath: "<landofile-fix>",
    bareShellParameters: "preserve",
  });
  if (
    Result.isFailure(parsed) ||
    !shellSafe ||
    replacements !== input.references.length ||
    parsed.success.segments.some((segment) => segment.kind === "SecretRefSegment")
  )
    return undefined;
  const env = Object.fromEntries(
    [...input.names].map(([reference, name]) => [name, `\${secret:${reference}}`]),
  );
  const parent = valueAtPath(input.document, input.bindingParent);
  if (parent !== undefined && (isLandofileReset(parent) || !isPlainRecord(parent))) return undefined;
  const edits: ValidationFixEdit[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (parent !== undefined && Object.hasOwn(parent, name)) {
      if (valueAtPath(parent, [name]) !== value) return undefined;
    } else edits.push({ op: "set", path: [...input.bindingParent, name], value });
  }
  const replacementEdit: ValidationFixEdit = {
    op: "set",
    path: input.path,
    value: input.shorthand ? { cmd: replacement } : replacement,
  };
  const [first, ...rest] = edits;
  const fix: ValidationFix = {
    edits: input.shorthand
      ? [replacementEdit, ...edits]
      : first === undefined
        ? [replacementEdit]
        : [first, ...rest, replacementEdit],
  };
  fixRedactor ??= createRedactor("secrets");
  const redactor = fixRedactor;
  if (!Bun.deepEquals(redactor.redactValue(fix), fix)) return undefined;
  let stringsSurvive = true;
  JSON.stringify(fix, (key, value: unknown) => {
    if (
      redactor.redactString(key) !== key ||
      (typeof value === "string" && redactor.redactString(value) !== value)
    )
      stringsSurvive = false;
    return value;
  });
  return stringsSurvive ? fix : undefined;
};
