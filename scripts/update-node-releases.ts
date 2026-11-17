#!/usr/bin/env bun
import { resolve } from "node:path";
import { causeMessage } from "@lando/sdk/errors";
import {
  NODE_RELEASES_SOURCE,
  NodeReleasesError,
  readNodeReleasesManifest,
  reportNodeReleasesUpdate,
  transformNodeSchedule,
} from "./node-releases.ts";

/** Injectable fetch so tests exercise the updater without network access. */
export type NodeScheduleFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Scripts own their HTTP egress; the shipped runtime uses `@lando/http-client`. */
export const nodeScheduleFetch: NodeScheduleFetch = (url, init) =>
  fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(30_000) });

export const todayIsoDate = (): string => new Date().toISOString().slice(0, 10);

export const readNodeSchedule = async (request: NodeScheduleFetch = nodeScheduleFetch): Promise<unknown> => {
  const response = await request(NODE_RELEASES_SOURCE);
  if (!response.ok) {
    throw new NodeReleasesError(`Node release schedule: HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new NodeReleasesError(`Node release schedule is not valid JSON: ${causeMessage(cause)}`);
  }
};

/**
 * Refresh codename, LTS date, and end date for the already-supported majors.
 * The major set is never changed here; a new LTS major is only reported.
 */
export const updateNodeReleases = async (
  directory = resolve(import.meta.dirname, "../plugins/service-lando/node"),
  request: NodeScheduleFetch = nodeScheduleFetch,
  today = todayIsoDate(),
) => {
  const manifestPath = resolve(directory, "releases.json");
  const previous = await readNodeReleasesManifest(manifestPath);
  const update = transformNodeSchedule(await readNodeSchedule(request), previous, today);
  const changed = JSON.stringify(previous) !== JSON.stringify(update.manifest);
  if (changed) {
    await Bun.write(manifestPath, `${JSON.stringify(update.manifest, null, 2)}\n`);
  }
  return { changed, newLtsMajors: update.newLtsMajors, previous, manifest: update.manifest };
};

/**
 * A Node LTS major outside the supported catalog leaves the manifest unchanged, so no
 * proposal PR would carry the report. Fail instead, which files the automation's
 * tracking issue, so a new LTS line never goes unnoticed.
 */
export const unshippedLtsFailure = (result: {
  readonly changed: boolean;
  readonly newLtsMajors: ReadonlyArray<{
    readonly major: number;
    readonly codename: string;
    readonly lts: string;
  }>;
}): string | undefined => {
  if (result.changed || result.newLtsMajors.length === 0) return undefined;
  const lines = result.newLtsMajors.map(
    (release) =>
      `Node ${release.major} (${release.codename}) entered LTS on ${release.lts}, but Lando does not ship it.`,
  );
  return `${lines.join("\n")}\nAdd the major to plugins/service-lando/node/releases.json and its node:<major> service type as a reviewed catalog change.\n`;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = "Usage: bun run update:node-releases (explicit network update; --help prints this message)";
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${usage}\n`);
  } else {
    if (args.length !== 0) throw new TypeError(usage);
    const result = await updateNodeReleases();
    process.stdout.write(reportNodeReleasesUpdate(result.previous, result.manifest, result.newLtsMajors));
    const failure = unshippedLtsFailure(result);
    if (failure !== undefined) {
      process.stderr.write(failure);
      process.exitCode = 1;
    }
  }
}
