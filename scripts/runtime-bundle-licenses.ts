import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sourcePatchFor } from "./linux-podman-source-build.ts";
import type { RuntimeBundleComponent } from "./runtime-bundle-sources.ts";

export const runtimeBundleRecipeUrls = (
  component: RuntimeBundleComponent,
  runtimeVersion: string,
  repository: string,
): readonly string[] => {
  if (component.sourceBuild === undefined) return [];
  const root = `https://github.com/${repository}/tree/runtime-v${runtimeVersion}/scripts`;
  const patch = sourcePatchFor(component);
  return patch === undefined ? [root] : [root, `${root}/patches/${basename(patch)}`];
};

export const stageRuntimeBundleLicenses = async (options: {
  readonly components: readonly RuntimeBundleComponent[];
  readonly runtimeVersion: string;
  readonly repository: string;
  readonly stageDir: string;
  readonly fetchArtifact: (url: string) => Promise<Uint8Array>;
}): Promise<void> => {
  const root = join(options.stageDir, "bin", "licenses");
  const notices = ["# Third-party notices", "", `Lando runtime bundle ${options.runtimeVersion}.`, ""];
  for (const component of [...options.components].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const dir = join(root, component.name);
    await mkdir(dir, { recursive: true });
    notices.push(
      `## ${component.name} ${component.version}`,
      "",
      `SPDX: ${component.license.spdx}`,
      "",
      `Source: ${component.license.source}`,
      "",
    );
    for (const url of runtimeBundleRecipeUrls(component, options.runtimeVersion, options.repository)) {
      notices.push(`Build recipe: ${url}`, "");
    }
    for (const text of component.license.texts) {
      const bytes = await options.fetchArtifact(text.url);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== text.sha256) {
        throw new Error(
          `assemble-runtime-bundle: sha256 verify failed for ${component.name} license (${text.url}): expected ${text.sha256}, got ${actual}`,
        );
      }
      await writeFile(join(dir, text.file), bytes);
      await chmod(join(dir, text.file), 0o644);
      notices.push(
        `- [${component.name}/${text.file}](${component.name}/${text.file}) (upstream: ${text.url})`,
      );
    }
    notices.push("");
  }
  const noticesPath = join(root, "THIRD_PARTY_NOTICES.md");
  await writeFile(noticesPath, `${notices.join("\n")}\n`);
  await chmod(noticesPath, 0o644);
};
