#!/usr/bin/env bun
/**
 * Regenerate `plugins/service-lando/src/services/generated/node-releases.ts`
 * from the committed `plugins/service-lando/node/releases.json` pin manifest.
 *
 * The generated module keeps literal major and version types so the service
 * table stays type-safe without hand-maintaining codenames or the LTS alias.
 */
import { resolve } from "node:path";
import { writeFormattedOutput } from "./_codegen-output.ts";
import {
  NODE_RELEASES_MANIFEST_PATH,
  type NodeReleasesManifest,
  readNodeReleasesManifest,
} from "./node-releases.ts";

const root = resolve(import.meta.dirname, "..");
export const NODE_RELEASES_OUTPUT = resolve(
  root,
  "plugins/service-lando/src/services/generated/node-releases.ts",
);
export const NODE_RELEASES_MANIFEST = resolve(root, NODE_RELEASES_MANIFEST_PATH);

export const buildNodeReleasesCatalog = (manifest: NodeReleasesManifest): string => {
  const records = [...manifest.releases]
    .sort((left, right) => left.major - right.major)
    .map(({ major, codename, lts, end }) => ({ major, codename, lts, end }));
  const versions = ["lts", ...records.map((record) => String(record.major))];
  return `/**
 * **GENERATED FILE** — do not edit by hand.
 * Regenerate via \`bun run codegen:node-releases\`.
 * Source: \`${NODE_RELEASES_MANIFEST_PATH}\`.
 */
export const NODE_RELEASE_SOURCE = ${JSON.stringify(manifest.source)} as const;
export const NODE_RELEASES = ${JSON.stringify(records, null, 2)} as const;
export const SUPPORTED_NODE_VERSIONS = ${JSON.stringify(versions)} as const;
`;
};

export const readCommittedNodeReleases = async (repositoryRoot = root): Promise<NodeReleasesManifest> =>
  readNodeReleasesManifest(resolve(repositoryRoot, NODE_RELEASES_MANIFEST_PATH));

if (import.meta.main) {
  await writeFormattedOutput(
    NODE_RELEASES_OUTPUT,
    buildNodeReleasesCatalog(await readCommittedNodeReleases()),
  );
}
