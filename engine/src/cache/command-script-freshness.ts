import { createHash } from "node:crypto";
import {
  type BunShellScriptInspection,
  type DiscoveredBunShellScript,
  inspectBunShellScripts,
  inspectScriptContent,
} from "@lando/landofile/bun-sh-discovery";
import { normalizeBunShellScript } from "@lando/landofile/bun-sh-metadata";
import { readBunShellScriptSource } from "@lando/landofile/bun-sh-script";
import { Effect, Result } from "effect";
import { canonicalCacheJson } from "./canonical.ts";

export type CommandScriptFingerprint = { readonly relativePath: string } & (
  | { readonly sha256: string; readonly invalid?: never }
  | { readonly invalid: string; readonly sha256?: never }
);

const fingerprint = (script: DiscoveredBunShellScript): CommandScriptFingerprint => {
  const task = Result.getOrThrowWith(normalizeBunShellScript(script), (error) => error);
  return {
    relativePath: script.relativePath,
    sha256: createHash("sha256")
      .update(
        canonicalCacheJson({
          relativePath: script.relativePath,
          frontMatter: script.frontMatter,
          input: task.input,
        }),
      )
      .digest("hex"),
  };
};

export const fingerprintsFromInspection = (
  inspection: BunShellScriptInspection,
): readonly CommandScriptFingerprint[] => {
  const io = inspection.problems.find((problem) => problem.io);
  if (io !== undefined) throw io.error;
  const scripts = new Map(inspection.scripts.map((script) => [script.relativePath, script]));
  return inspection.files.map((file) => {
    const script = scripts.get(file.relativePath);
    return script === undefined
      ? { relativePath: file.relativePath, invalid: file.contentDigest }
      : fingerprint(script);
  });
};

export const commandScriptFingerprints = async (
  appRoot: string,
): Promise<readonly CommandScriptFingerprint[]> =>
  fingerprintsFromInspection(await Effect.runPromise(inspectBunShellScripts({ appRoot })));

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
      const source = await Effect.runPromise(readBunShellScriptSource(appRoot, cached.relativePath));
      // A removed script stales the index so the next call rebuilds instead of routing to nothing.
      if (source === undefined) return false;
      if (cached.invalid !== undefined)
        return createHash("sha256").update(source.content).digest("hex") === cached.invalid;
      const { script } = await Effect.runPromise(
        inspectScriptContent(source.path, cached.relativePath, source.content),
      );
      return script !== undefined && fingerprint(script).sha256 === cached.sha256;
    }),
  );
  return results.every(Boolean);
};
