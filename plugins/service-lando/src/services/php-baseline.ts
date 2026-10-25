import { coerce, gte } from "semver";

import type { ServiceBuildStepIntent } from "@lando/sdk/services";

import { phpImageFor } from "./php-via.ts";

export const PHP_BASELINE_STEP_ID = "service-lando.php:baseline" as const;
export const PHP_BASELINE_INI_PATH = "/usr/local/etc/php/conf.d/10-lando-baseline.ini";

/**
 * First patched release that retires a baseline directive on that PHP line.
 * The official Hub tags are still floating minors (`php:8.3-apache-bookworm`);
 * pin a patch (`php:8.3.37-apache-bookworm`) when a line is fixed so the
 * retirement test can see it.
 */
export const PHP_BASELINE_REMOVE_WHEN = {
  "8.1": "8.1.34",
  "8.2": "8.2.36",
  "8.3": "8.3.37",
  "8.4": "8.4.28",
  "8.5": "8.5.13",
  "8.6": "8.6.0",
} as const;

export type PhpBaselineLine = keyof typeof PHP_BASELINE_REMOVE_WHEN;

export interface PhpSecurityBaselineEntry {
  readonly setting: string;
  readonly value: string;
  readonly reason: string;
  readonly advisoryUrl: string;
  readonly removeWhen: Readonly<Record<PhpBaselineLine, string>>;
}

export const PHP_SECURITY_BASELINE: ReadonlyArray<PhpSecurityBaselineEntry> = [
  {
    setting: "session.upload_progress.enabled",
    value: "0",
    reason: "php.net 2026-10-23 advisory for CVE-2026-115560; no patched release yet",
    advisoryUrl: "https://www.php.net/archive/2026.php#2026-10-23-1",
    removeWhen: PHP_BASELINE_REMOVE_WHEN,
  },
];

const commentSafe = (value: string): string => {
  if (value.includes("'") || value.includes("\n")) {
    throw new Error("PHP baseline comments cannot contain quotes or newlines");
  }
  return value;
};

const settingSafe = (value: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9._]*$/u.test(value)) {
    throw new Error(`Invalid PHP ini setting ${JSON.stringify(value)}`);
  }
  return value;
};

const valueSafe = (value: string): string => {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`Invalid PHP ini value ${JSON.stringify(value)}`);
  }
  return value;
};

const removalTrigger = (removeWhen: PhpSecurityBaselineEntry["removeWhen"]): string =>
  `drop when fixed in ${Object.values(removeWhen).join(", ")}`;

export const renderPhpBaselineIni = (
  entries: ReadonlyArray<PhpSecurityBaselineEntry> = PHP_SECURITY_BASELINE,
): string => {
  const lines: Array<string> = ["; Lando-managed PHP security baseline"];
  for (const entry of entries) {
    lines.push(`; ${commentSafe(entry.reason)}`);
    lines.push(`; Advisory: ${commentSafe(entry.advisoryUrl)}`);
    lines.push(`; ${commentSafe(removalTrigger(entry.removeWhen))}`);
    lines.push(`${settingSafe(entry.setting)} = ${valueSafe(entry.value)}`);
  }
  return `${lines.join("\n")}\n`;
};

const shellSingleQuote = (value: string): string => {
  if (value.includes("'")) {
    throw new Error("PHP baseline ini lines cannot contain single quotes");
  }
  return `'${value}'`;
};

export const phpBaselineIniCommand = (content: string, path = PHP_BASELINE_INI_PATH): string => {
  const lines = content.replace(/\n$/u, "").split("\n");
  return `printf '%s\\n' ${lines.map(shellSingleQuote).join(" ")} > ${path}`;
};

export const phpBaselineBuildStep = (
  entries: ReadonlyArray<PhpSecurityBaselineEntry> = PHP_SECURITY_BASELINE,
): ServiceBuildStepIntent | undefined => {
  if (entries.length === 0) return undefined;
  const content = renderPhpBaselineIni(entries);
  return {
    id: PHP_BASELINE_STEP_ID,
    phase: "build",
    command: ["set -eux", phpBaselineIniCommand(content)].join(" && "),
    user: "root",
    buildKeyInputs: { phpBaseline: { path: PHP_BASELINE_INI_PATH, content, entries } },
  };
};

/**
 * Official tags look like `php:8.3-apache-bookworm`, `php:8.6-rc-apache-bookworm`,
 * or a future patch pin such as `php:8.3.37-apache-bookworm`.
 */
export const stockPhpImageVersion = (line: string, via: "apache" | "fpm" | "cli" = "apache"): string => {
  const ref = phpImageFor(line, via);
  const prefix = "php:";
  const suffix = `-${via}-bookworm`;
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) {
    throw new Error(`Unexpected PHP image ref ${ref}`);
  }
  const token = ref.slice(prefix.length, -suffix.length);
  const rc = /^(\d+\.\d+)-rc(?:\.(\d+))?$/u.exec(token);
  const normalized = rc === null ? (/^\d+\.\d+$/u.test(token) ? `${token}.0` : token) : `${rc[1]}.0-rc.${rc[2] ?? "0"}`;
  const parsed = coerce(normalized, { includePrerelease: true });
  if (parsed === null) throw new Error(`Cannot parse PHP version from ${ref}`);
  return parsed.version;
};

export const phpBaselineEntryIsRetired = (
  entry: PhpSecurityBaselineEntry,
  imageVersionFor: (line: PhpBaselineLine) => string = (line) => stockPhpImageVersion(line),
): boolean => {
  const lines = Object.keys(entry.removeWhen) as Array<PhpBaselineLine>;
  return lines.every((line) => gte(imageVersionFor(line), entry.removeWhen[line]));
};
