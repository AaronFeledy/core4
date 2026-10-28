import { readFile } from "node:fs/promises";
import { assembleBundle } from "../assemble-runtime-bundle.ts";
import { assertNativeLinuxBundle } from "../linux-runtime-bundle-builder.ts";
import { fetchOverHttps } from "../runtime-bundle-fetch.ts";
import { RUNTIME_BUNDLE_SOURCES_PATH, parseRuntimeBundleSources } from "../runtime-bundle-sources.ts";

const hostKey = process.argv[2] ?? "";
const repository = process.argv[3] ?? "";
assertNativeLinuxBundle(hostKey);
if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("Invalid bundle repository");
await assembleBundle({
  hostKey,
  repository,
  sources: parseRuntimeBundleSources(JSON.parse(await readFile(RUNTIME_BUNDLE_SOURCES_PATH, "utf8"))),
  outDir: "/out",
  fetchArtifact: fetchOverHttps,
});
