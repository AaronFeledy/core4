#!/usr/bin/env bun
import { resolve } from "node:path";

import { listenerContracts } from "@lando/service-lando";

const OUTPUT = resolve(import.meta.dirname, "../docs/reference/service-listeners.mdx");
type Contracts = ReturnType<typeof listenerContracts>;

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

export const renderServiceListenerReference = (contracts: Contracts = listenerContracts()): string => {
  const entries = Object.entries(contracts).sort(([left], [right]) => left.localeCompare(right));
  const families = [...new Set(entries.map(([key]) => key.split("/")[0] ?? key))].sort();
  const sections = families.flatMap((family) => [
    `## ${code(family)}`,
    "",
    ...entries
      .filter(([key]) => key === family || key.startsWith(`${family}/`))
      .sort(([left], [right]) => (left === family ? -1 : right === family ? 1 : left.localeCompare(right)))
      .flatMap(([key, contract]) => {
        const rows: (readonly [string, string])[] = [
          ["Daemon", code(contract.daemon)],
          ["Default port", code(contract.port)],
          ["Port variables", contract.variables?.map(code).join(", ") || "None"],
          ["Bind variables", contract.bindVariables?.map(code).join(", ") || "None"],
          [
            "List bind variable",
            contract.listVariable
              ? `${code(contract.listVariable)} (comma-separated wildcard binds)`
              : "None",
          ],
          [
            "Host defaults",
            Object.entries(contract.hostDefaults ?? {})
              .map(([name, value]) => code(`${name}=${value}`))
              .join(", ") || "None",
          ],
          [
            "Secondary listeners (collision-reserved)",
            contract.reserved?.map(({ port, use }) => `${code(port)}: ${text(use)}`).join("; ") || "None",
          ],
          [
            "Derived secondary listeners",
            contract.derived
              ?.map(
                ({ use, offset, variable, loopback }) =>
                  `${text(use)}: ${code(`port ${offset < 0 ? "-" : "+"} ${Math.abs(offset)}`)}${variable ? ` unless ${code(variable)} is authored` : ""}${loopback ? " (loopback only)" : ""}`,
              )
              .join("; ") || "None",
          ],
          [
            "Authored launcher argument",
            contract.launcher ? code(contract.launcher.setting(contract.port)) : "Not specified",
          ],
          [
            "Custom image setting",
            contract.image ? code(contract.image.setting(contract.port)) : "Not specified",
          ],
          ["Custom image file", contract.image?.file ? code(contract.image.file) : "Not specified"],
        ];
        return [
          ...(key === family ? [] : [`### ${code(key)}`, ""]),
          ...(contract.when ? [`Applies when: ${text(contract.when)}`, ""] : []),
          "| Listener field | Value |",
          "| --- | --- |",
          ...rows.map(([label, value]) => `| ${label} | ${value} |`),
          "",
        ];
      }),
  ]);
  return [
    "---",
    "title: Service listeners",
    "description: Default ports, listener variables, secondary ports, and launcher or image requirements.",
    "---",
    "",
    "{/* GENERATED FILE. Regenerate with `bun run codegen:service-listener-reference`. */}",
    "",
    "# Service listeners",
    "",
    "Set `port:` to choose a service's primary internal listener port. These contracts list the bundled defaults, followed by each family's variants. Port variables and wildcard bind variables follow the planned port; host defaults remain overridable. A declared endpoint does not start your application server.",
    "",
    "Secondary listeners are collision-reserved: the primary port cannot reuse them while that contract applies. Some reservations apply only when Lando owns the configuration or launcher; read the applicability notes for the service or variant. These are internal container ports, not published host ports.",
    "",
    "Launcher arguments and custom image settings below use the default port. Substitute your chosen `port:` when replacing a Lando-owned launcher or supplying your own image configuration. Not specified means the contract declares no requirement for that field, not that any replacement will listen correctly.",
    "",
    ...sections,
  ].join("\n");
};

// Like the service-type reference, MDX is emitted directly: Biome does not support MDX.
if (import.meta.main) await Bun.write(OUTPUT, renderServiceListenerReference());
