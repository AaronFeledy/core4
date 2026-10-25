import type { ServiceBuildStepIntent } from "@lando/sdk/services";

export const PHP_BASELINE_STEP_ID = "service-lando.php:baseline" as const;
export const PHP_BASELINE_INI_PATH = "/usr/local/etc/php/conf.d/10-lando-baseline.ini";

export interface PhpSecurityBaselineEntry {
  readonly setting: string;
  readonly value: string;
  readonly reason: string;
  readonly advisoryUrl: string;
  readonly removeWhen: string;
}

export const PHP_SECURITY_BASELINE: ReadonlyArray<PhpSecurityBaselineEntry> = [
  {
    setting: "session.upload_progress.enabled",
    value: "0",
    reason: "php.net 2026-10-23 advisory for CVE-2026-115560; no patched release yet",
    advisoryUrl: "https://www.php.net/archive/2026.php#2026-10-23-1",
    removeWhen: "next php.net bugfix release that fixes CVE-2026-115560 on every supported line",
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

export const renderPhpBaselineIni = (
  entries: ReadonlyArray<PhpSecurityBaselineEntry> = PHP_SECURITY_BASELINE,
): string => {
  const lines: Array<string> = ["; Lando-managed PHP security baseline"];
  for (const entry of entries) {
    lines.push(`; ${commentSafe(entry.reason)}`);
    lines.push(`; Advisory: ${commentSafe(entry.advisoryUrl)}`);
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
