import type { SummaryField, SummaryRow, SummarySection } from "@lando/renderer/summary";
import type { DoctorCheck, DoctorSolution, DoctorStatus } from "./doctor-contract";
import { renderSolution } from "./doctor-render-text";

export interface DoctorRenderOptions {
  readonly all?: boolean | undefined;
}

export interface DoctorTextCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly severity: string;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
  readonly capabilities?: DoctorCheck["capabilities"];
  readonly runtime?: DoctorCheck["runtime"];
  readonly runtimeStatus?: string;
  readonly providerId?: string;
}

const LIST_KEYS = new Set([
  "containers",
  "dataVolumes",
  "cacheVolumes",
  "volumes",
  "sessions",
  "apps",
  "providers",
  "files",
  "services",
  "bindings",
  "contributingPlugins",
  "attempts",
  "phases",
  "engines",
  "targets",
]);
const IDENTITY_KEYS = [
  "appRoot",
  "root",
  "appId",
  "journalPath",
  "statePath",
  "endpoint",
  "app",
  "service",
  "port",
  "section",
  "pluginPath",
  "pluginId",
  "checkId",
] as const;
const HEADER_KEYS = new Set([
  "provider",
  "providerId",
  "providerName",
  "providerKind",
  "providerVersion",
  "runtimeVersion",
  "selectionSource",
  "selectionInputFlag",
  "selectionInputLandofile",
  "selectionInputEnv",
  "selectionInputConfig",
  "selectionInputDefault",
  "platform",
]);

export const doctorContextValue = (key: string, value: string, all = false): string => {
  if (all) return value;
  const items = LIST_KEYS.has(key) ? value.split(/,\s*/) : [value];
  const shown = items.slice(0, 3).map((item) => (item.length > 240 ? `${item.slice(0, 240)}...` : item));
  return `${shown.join(", ")}${items.length > 3 ? ` (+${items.length - 3} more)` : ""}`;
};

const solutionText = (solution: DoctorSolution): string => {
  const command = solution.command;
  return command === undefined ||
    command.length === 0 ||
    command === "lando doctor" ||
    solution.description.includes(command)
    ? solution.description
    : `${solution.description} Run \`${command}\`.`;
};

const contributor = (check: DoctorTextCheck): string =>
  check.context.contributor ??
  check.context.pluginId ??
  check.context.checkId ??
  check.context.subsystemId ??
  check.providerId ??
  "core";

const groupChecks = (
  checks: ReadonlyArray<DoctorTextCheck>,
): ReadonlyArray<readonly [DoctorTextCheck, ...DoctorTextCheck[]]> => {
  const groups = new Map<string, [DoctorTextCheck, ...DoctorTextCheck[]]>();
  for (const check of checks) {
    const key = JSON.stringify([contributor(check), check.name, check.status]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [check]);
    else group.push(check);
  }
  return [...groups.values()];
};

const groupRemedy = (group: readonly [DoctorTextCheck, ...DoctorTextCheck[]]): string | undefined => {
  const variants = new Set(group.map((check) => JSON.stringify(check.solutions)));
  const head = group[0];
  if (variants.size === 1)
    return head.solutions.length === 0 ? undefined : head.solutions.map(solutionText).join(" ");
  const common = [
    ...new Set(head.solutions.flatMap((solution) => (solution.command ? [solution.command] : []))),
  ].filter((command) =>
    group.every((check) => check.solutions.some((solution) => solution.command === command)),
  );
  return [
    `${variants.size} remediation variants (lando doctor --all)`,
    ...common.map((command) => `Run \`${command}\`.`),
  ].join(" ");
};

const groupFields = (
  group: readonly [DoctorTextCheck, ...DoctorTextCheck[]],
  all: boolean,
): ReadonlyArray<SummaryField> => {
  const head = group[0];
  const fields: SummaryField[] = [];
  const identityKeys: string[] = [];
  if (all) {
    fields.push({ label: "severity", value: head.severity });
    if (head.runtimeStatus !== undefined) fields.push({ label: "runtimeStatus", value: head.runtimeStatus });
    if (head.runtime?.message !== undefined)
      fields.push({ label: "runtimeMessage", value: head.runtime.message });
    if (head.runtime?.oomKilled !== undefined)
      fields.push({ label: "oomKilled", value: String(head.runtime.oomKilled) });
    for (const [label, value] of Object.entries(head.capabilities ?? {}))
      fields.push({ label, value: typeof value === "object" ? JSON.stringify(value) : String(value) });
  }
  if (group.length > 1) {
    for (const key of IDENTITY_KEYS) {
      const seen = new Map<string, string | undefined>();
      const distinguishes = group.some((check) => {
        const identity = JSON.stringify(identityKeys.map((key) => check.context[key]));
        const value = check.context[key];
        if (seen.has(identity) && seen.get(identity) !== value) return true;
        seen.set(identity, value);
        return false;
      });
      if (distinguishes) identityKeys.push(key);
    }
    if (identityKeys.length === 0) {
      const key = IDENTITY_KEYS.find((key) => group.some((check) => check.context[key] !== undefined));
      if (key !== undefined) identityKeys.push(key);
    }
    const identities = group
      .slice(0, 3)
      .map((check) =>
        identityKeys.length === 0
          ? check.name
          : identityKeys
              .map((key) => `${key}: ${doctorContextValue(key, check.context[key] ?? "-")}`)
              .join(", "),
      );
    fields.push({ label: "entries", value: identities.join("; ") });
    if (group.length > 3)
      fields.push({ label: "remaining", value: `+${group.length - 3} more (lando doctor --all)` });
  }
  for (const [label, value] of Object.entries(head.context)) {
    if (HEADER_KEYS.has(label) && !(all && label === "platform")) continue;
    if (
      group.length > 1 &&
      (identityKeys.includes(label) || !group.every((check) => check.context[label] === value))
    )
      continue;
    fields.push({ label, value: doctorContextValue(label, value, all) });
  }
  return fields;
};

export const doctorCheckSection = (
  title: string,
  checks: ReadonlyArray<DoctorTextCheck>,
  options: DoctorRenderOptions,
): SummarySection | undefined => {
  const all = options.all === true;
  const visible = all ? checks : checks.filter((check) => check.status !== "pass");
  if (!all && visible.length === 0) return undefined;
  const groups = all ? visible.map((check): readonly [DoctorTextCheck] => [check]) : groupChecks(visible);
  const rows: SummaryRow[] = groups.map((group) => {
    const head = group[0];
    const remedy = all ? head.solutions.map(renderSolution).join("\n") : groupRemedy(group);
    return {
      label: head.name,
      tone: head.status === "pass" ? "ok" : head.status === "warn" ? "warn" : "error",
      value: group.length === 1 ? head.status : `${head.status} (${group.length} checks)`,
      fields: groupFields(group, all),
      ...(remedy ? { remedy } : {}),
    };
  });
  return { title, rows, ...(checks.length === 0 ? { notes: ["No checks reported."] } : {}) };
};

export const doctorNextSteps = (
  checks: ReadonlyArray<DoctorTextCheck>,
  options: DoctorRenderOptions,
): ReadonlyArray<string> => {
  const commands = new Set<string>();
  const names = new Set<string>();
  for (const check of checks) {
    if (check.status === "pass" || (options.all !== true && names.has(check.name))) continue;
    for (const solution of check.solutions) {
      const command = solution.command;
      if (!command || command === "lando doctor" || commands.has(command)) continue;
      commands.add(command);
      names.add(check.name);
      if (options.all !== true) break;
    }
  }
  return [...commands];
};
