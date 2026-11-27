#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
import {
  DAY_MS,
  type LookupOptions,
  STALE_AFTER_DAYS,
  type TagLookup,
  makeStockArtifactLookup,
} from "./stock-artifact-registry.ts";

export const runStockArtifactAgeCanary = async (
  options: LookupOptions = {},
): Promise<readonly TagLookup[]> => {
  const { stockArtifactReferences } = await import("./stock-artifact-inventory.ts");
  const lookup = makeStockArtifactLookup(options);
  const rows: TagLookup[] = [];
  for (const ref of stockArtifactReferences()) rows.push(await lookup(ref));
  return rows;
};

const formatCanarySummary = (lookups: readonly TagLookup[], now: number): string => {
  const lines = [
    "# Stock artifact age canary",
    "",
    "Advisory: stock service catalog images and built-in defaults, including PHP Apache, FPM, and CLI bases.",
    "Mutable Docker Hub tags use tag update time. Other registries and digest pins use image config creation time (Linux amd64 preferred for an index).",
    "This does not replace the stock PHP weekly refresh or rebuild `refresh:true`.",
    "",
    `Checked ${lookups.length} image references. Images older than ${STALE_AFTER_DAYS} days are stale.`,
  ];
  for (const [verdict, heading] of [
    ["stale", "Stale"],
    ["unknown", "Unknown"],
    ["fresh", "Fresh"],
  ] as const) {
    const rows = lookups.filter((lookup) => lookup.verdict === verdict);
    lines.push("", `## ${heading} (${rows.length})`, "");
    if (rows.length === 0) {
      lines.push("None.");
      continue;
    }
    lines.push("| Image reference | Observation |", "| --- | --- |");
    for (const row of rows) {
      const observation =
        row.verdict === "unknown"
          ? row.detail
          : `${new Date(row.rebuiltAtMs).toISOString()} (${Math.floor((now - row.rebuiltAtMs) / DAY_MS)} days; ${row.source})`;
      lines.push(`| \`${row.tag}\` | ${observation} |`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const warning = (title: string, message: string) => {
  const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stdout.write(`::warning title=${title}::${escaped}\n`);
};

if (import.meta.main) {
  let markdown: string;
  try {
    const lookups = await runStockArtifactAgeCanary();
    markdown = formatCanarySummary(lookups, Date.now());
    for (const row of lookups) {
      if (row.verdict === "stale") {
        warning(
          "Stale stock image",
          `${row.tag}: ${new Date(row.rebuiltAtMs).toISOString()} (${row.source})`,
        );
      } else if (row.verdict === "unknown") {
        warning("Unknown stock image age", `${row.tag}: ${row.detail}`);
      }
    }
  } catch (error) {
    warning("Stock artifact age canary failed", error instanceof Error ? error.message : String(error));
    markdown = "# Stock artifact age canary\n\nNo image ages reported: see the warning in the job log.\n";
  }
  process.stdout.write(markdown);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      await appendFile(summaryPath, markdown);
    } catch (error) {
      warning("Stock artifact age canary summary", error instanceof Error ? error.message : String(error));
    }
  }
}
