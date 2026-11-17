import {
  SUPPORTED_NODE_VERSIONS as GENERATED_NODE_VERSIONS,
  NODE_RELEASES,
} from "./generated/node-releases.ts";

/**
 * Supported Node majors come from the committed release pin manifest. Adding or
 * removing a major is a catalog decision in `plugins/service-lando/node/releases.json`,
 * not something the scheduled bump can do.
 */
export const SUPPORTED_NODE_MAJORS = NODE_RELEASES;
export type SupportedNodeMajor = (typeof SUPPORTED_NODE_MAJORS)[number]["major"];

export const SUPPORTED_NODE_VERSIONS = GENERATED_NODE_VERSIONS;
export type SupportedNodeVersion = (typeof SUPPORTED_NODE_VERSIONS)[number];

/**
 * The newest supported major whose manifest entry records an LTS date. The
 * manifest only records that date once the major has entered LTS, so this stays
 * deterministic and offline.
 */
export const selectLatestLtsMajor = <Major extends number>(
  releases: ReadonlyArray<{ readonly major: Major; readonly lts: string | null }>,
): Major | undefined =>
  releases.reduce<Major | undefined>(
    (latest, release) =>
      release.lts !== null && (latest === undefined || release.major > latest) ? release.major : latest,
    undefined,
  );

const latestLts = selectLatestLtsMajor(SUPPORTED_NODE_MAJORS);
if (latestLts === undefined) {
  throw new Error("Node release manifest has no LTS major.");
}
export const NODE_LTS_MAJOR: SupportedNodeMajor = latestLts;

export const NODE_ARTIFACTS: Readonly<Record<SupportedNodeVersion, string>> = Object.fromEntries([
  ["lts", `node:${NODE_LTS_MAJOR}`],
  ...SUPPORTED_NODE_MAJORS.map((entry) => [String(entry.major), `node:${entry.major}`] as const),
]) as Readonly<Record<SupportedNodeVersion, string>>;
