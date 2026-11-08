#!/usr/bin/env bun
import { resolve } from "node:path";

import { CONFIG_LINT_RULES, type ConfigLintRuleDescriptor } from "@lando/sdk/schema";

const OUTPUT = resolve(import.meta.dirname, "../docs/reference/config-lint-rules.mdx");

export type ConfigLintRuleRegistry = Readonly<Record<string, ConfigLintRuleDescriptor>>;

/**
 * Stable heading/anchor id: dots become hyphens (`landofile.hostname` -> `landofile-hostname`).
 * Non [A-Za-z0-9_-] runs collapse so MDX link fragments stay expression-safe.
 */
export const configLintRuleAnchorId = (ruleId: string): string => {
  const hyphenated = ruleId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return hyphenated.length > 0 ? hyphenated : "rule";
};

const text = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("\\", "&#92;")
    .replace(/\s+/g, " ");

const code = (value: string | number): string => {
  const content = String(value).replaceAll("|", "\\|").replace(/\s+/g, " ");
  const delimiter = "`".repeat(Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${delimiter} ${content} ${delimiter}`;
};

const listCell = (values: readonly string[]): string => values.map((value) => code(value)).join(", ");

/** Prose with backtick spans: the spans become code, everything else is escaped text. */
const prose = (value: string): string =>
  value
    .split(/(`[^`]+`)/u)
    .map((part) =>
      part.length > 2 && part.startsWith("`") && part.endsWith("`") ? code(part.slice(1, -1)) : text(part),
    )
    .join("");

export const renderConfigLintRuleReference = (rules: ConfigLintRuleRegistry = CONFIG_LINT_RULES): string => {
  const rows = Object.entries(rules)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, descriptor]) =>
        `| <span id="${configLintRuleAnchorId(id)}">${code(id)}</span> | ${descriptor.severities.map((severity) => text(severity)).join(" or ")} | ${prose(descriptor.summary)} | ${listCell(descriptor.examplePaths)} | ${listCell(descriptor.stages)} |`,
    );

  return [
    "---",
    "title: Config lint rules",
    "description: Every rule id that lando app:config:lint reports, with what it checks, its severity, and example paths.",
    "---",
    "",
    "{/* GENERATED FILE. Regenerate with `bun run codegen:config-lint-rule-reference`. */}",
    "",
    "# Config lint rules",
    "",
    "Every finding from `lando app:config:lint` carries one of these `rule` ids. Planning failures and global config validation reuse the same ids in each issue's `rule`. Example paths are written the way lint prints them.",
    "",
    "Stages say when the check runs:",
    "",
    "- `fragment`: each authored file, before layers merge.",
    "- `load`: loading, including, and merging Landofile sources.",
    "- `effective`: the merged configuration.",
    "- `resolve`: the resolved configuration, after expressions evaluate. Lint and planning share these checks.",
    "- `planning`: `lando start`, `lando rebuild`, and `lando app:cache:refresh` also fail with this rule.",
    "- `global-config`: validation of your global `config.yml`.",
    "- `discovery`: `lando doctor --app` looking for the Landofile.",
    "",
    "| Rule | Severity | What it checks | Example paths | Stages |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

// Like the service-listener reference, MDX is emitted directly: Biome does not support MDX.
if (import.meta.main) await Bun.write(OUTPUT, renderConfigLintRuleReference());
