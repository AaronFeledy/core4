import { createHash } from "node:crypto";
import { type DiscoveredBunShellScript, discoverBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { readBunShellScript } from "@lando/landofile/bun-sh-script";
import { Effect } from "effect";
import { canonicalCacheJson } from "./canonical.ts";

export interface CommandScriptFingerprint {
  readonly relativePath: string;
  readonly sha256: string;
}

const fingerprint = (script: DiscoveredBunShellScript): CommandScriptFingerprint => ({
  relativePath: script.relativePath,
  sha256: createHash("sha256")
    .update(canonicalCacheJson({ relativePath: script.relativePath, frontMatter: script.frontMatter }))
    .digest("hex"),
});

export const commandScriptFingerprints = async (
  appRoot: string,
): Promise<readonly CommandScriptFingerprint[]> =>
  (await Effect.runPromise(discoverBunShellScripts({ appRoot, skipInvalid: true }))).map(fingerprint);

export const commandScriptsFresh = async (
  appRoot: string,
  scripts: readonly CommandScriptFingerprint[] | undefined,
  includeInventory = false,
): Promise<boolean> => {
  if (!Array.isArray(scripts)) return false;
  if (includeInventory)
    return canonicalCacheJson(scripts) === canonicalCacheJson(await commandScriptFingerprints(appRoot));
  const results = await Promise.all(
    scripts.map(async (cached) => {
      const result = await Effect.runPromise(Effect.result(readBunShellScript(appRoot, cached.relativePath)));
      switch (result._tag) {
        case "Failure":
          return false;
        case "Success":
          return result.success === undefined || fingerprint(result.success).sha256 === cached.sha256;
        default:
          return result satisfies never;
      }
    }),
  );
  return results.every(Boolean);
};
