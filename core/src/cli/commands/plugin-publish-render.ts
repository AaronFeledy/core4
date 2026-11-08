import type { PluginPublishResult } from "./plugin-publish";

export const renderPluginPublishResult = (result: PluginPublishResult): string => {
  const outcome = result.dryRun
    ? "dry-run (no publish)"
    : result.published
      ? "published"
      : `failed (exit ${result.exitCode})`;
  return [
    `plugin-publish: ${result.pluginName}`,
    `registry: ${result.registry}`,
    `tag: ${result.tag}`,
    `contents: ${result.packageContents.join(", ")}`,
    "validation: ok",
    `result: ${outcome}`,
  ].join("\n");
};
