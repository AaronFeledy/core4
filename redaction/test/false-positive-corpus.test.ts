/**
 * False-positive corpus for the canonical `secrets` profile.
 *
 * Real programs print lines that look like secret grammar but carry no
 * credential. Every entry in `fixtures/false-positive-corpus.txt` must survive
 * `redactString` and the line-stream unchanged, because masking it would break
 * a diagnostic a user needs. The smaller `fixtures/secret-lines.txt` set pins
 * the exact masked output for realistic secret-bearing lines.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactLineText } from "@lando/redaction/line-stream";
import { createRedactor } from "@lando/sdk/secrets";

const FIXTURES = join(import.meta.dir, "fixtures");

interface FixtureEntry {
  readonly group: string;
  readonly line: string;
}

interface SecretEntry extends FixtureEntry {
  readonly input: string;
  readonly expected: string;
}

/** One entry per non-comment, non-blank line; `# ` lines name the current source. */
const parseEntries = (text: string): readonly FixtureEntry[] => {
  let group = "";
  const entries: FixtureEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("# ")) {
      group = line.slice(1).trim();
      continue;
    }
    entries.push({ group, line });
  }
  return entries;
};

const parseSecretEntries = (text: string): readonly SecretEntry[] =>
  parseEntries(text).map(({ group, line }) => {
    const separator = line.indexOf("\t");
    if (separator < 0) throw new TypeError(`Secret fixture entry has no tab separator: ${line}`);
    return { group, line, input: line.slice(0, separator), expected: line.slice(separator + 1) };
  });

const falsePositives = parseEntries(readFileSync(join(FIXTURES, "false-positive-corpus.txt"), "utf8"));
const secretLines = parseSecretEntries(readFileSync(join(FIXTURES, "secret-lines.txt"), "utf8"));

const redactor = createRedactor("secrets");
const scope = { redactor, payloadValues: () => [] as readonly string[] };

describe("false-positive corpus", () => {
  for (const entry of falsePositives) {
    test(`${entry.group}: ${entry.line}`, () => {
      expect(redactor.redactString(entry.line), `${entry.group} (string)`).toBe(entry.line);
      expect(redactLineText(scope, entry.line), `${entry.group} (line-stream)`).toBe(entry.line);
    });
  }
});

describe("secret-bearing lines", () => {
  for (const entry of secretLines) {
    test(`${entry.group}: ${entry.input}`, () => {
      expect(redactor.redactString(entry.input), `${entry.group} (string)`).toBe(entry.expected);
      expect(redactLineText(scope, entry.input), `${entry.group} (line-stream)`).toBe(entry.expected);
    });
  }
});
