import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CI_PLATFORMS } from "./ci-platforms.ts";
import { compiledBinaryBundleConfig } from "./compiled-binary-bundle.ts";
import {
  CompiledBinaryLicenseError,
  discoverBundledPackageRoots,
  readPackageLicense,
  renderPackageLicense,
} from "./compiled-binary-licenses.ts";

export const BUN_LICENSE_PIN = {
  version: "1.4.3",
  sha256: "056696884250b0d682365260cf1487a6501b1665a343ec60e23a1e647043c572",
} as const;

export const verifyBunLicensePin = (version: string, text: string): void => {
  if (version.trim() !== BUN_LICENSE_PIN.version) {
    throw new CompiledBinaryLicenseError(
      `Bun license pin drift: .bun-version is ${version.trim()}, vendored license is ${BUN_LICENSE_PIN.version}. Update the vendored license and pin.`,
    );
  }
  if (createHash("sha256").update(text).digest("hex") !== BUN_LICENSE_PIN.sha256) {
    throw new CompiledBinaryLicenseError("Vendored Bun LICENSE.md checksum mismatch.");
  }
};

export const verifyBunCompilerVersion = (version: string): void => {
  if (version !== BUN_LICENSE_PIN.version && version !== `${BUN_LICENSE_PIN.version}-debug`) {
    throw new CompiledBinaryLicenseError(
      `Run notices generation with pinned Bun ${BUN_LICENSE_PIN.version} (or its local -debug build), not ${version}.`,
    );
  }
};

export const generateCompiledBinaryNotices = async (
  outfile = resolve(import.meta.dirname, "../dist/THIRD_PARTY_NOTICES.md"),
): Promise<void> => {
  const root = resolve(import.meta.dirname, "..");
  const bunLicense = await Bun.file(
    resolve(import.meta.dirname, `licenses/bun-${BUN_LICENSE_PIN.version}-LICENSE.md`),
  ).text();
  verifyBunLicensePin(await Bun.file(resolve(root, ".bun-version")).text(), bunLicense);
  verifyBunCompilerVersion(Bun.version);
  const roots = new Set<string>();
  for (const platform of CI_PLATFORMS) {
    const output = await Bun.build({
      ...compiledBinaryBundleConfig(platform.id, "4.0.0-dev.0", [resolve(root, "core/bin/lando.ts")]),
      metafile: true,
    });
    if (!output.success)
      throw new CompiledBinaryLicenseError(output.logs.map((log) => log.message).join("\n"));
    if (output.metafile === undefined)
      throw new CompiledBinaryLicenseError("Bun did not return a build metafile.");
    for (const packageRoot of await discoverBundledPackageRoots(output.metafile, process.cwd()))
      roots.add(packageRoot);
  }
  const packages = await Promise.all([...roots].map(readPackageLicense));
  packages.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
  );
  const parts = [
    "# Third-party notices\n\n",
    "This file covers the Bun runtime and the union of npm code/assets bundled across all six Lando release targets. The binary also embeds a static in-container helper built with Go; the Go standard library's LICENSE and PATENTS ship next to the binary as `container-helper-go-LICENSE` and `container-helper-go-PATENTS`.\n\n",
    `## Bun ${BUN_LICENSE_PIN.version}\n\nSource: https://github.com/oven-sh/bun/blob/bun-v${BUN_LICENSE_PIN.version}/LICENSE.md\n\n`,
    "````text\n",
    bunLicense,
    "\n````\n\n",
    "## Relink with a modified JavaScriptCore\n\n",
    `Lando source is public at https://github.com/AaronFeledy/core4. Check out the release tag that matches your binary. Build Bun from tag \`bun-v${BUN_LICENSE_PIN.version}\` with your modified JavaScriptCore using Bun's LICENSE.md instructions above, then use that Bun to install Lando's locked dependencies (\`bun install --frozen-lockfile --os='*' --cpu='*'\`), run \`bun run codegen\`, and run \`bun run scripts/build-compiled-binary.ts --outfile ./dist/lando\`. The local \`${BUN_LICENSE_PIN.version}-debug\` build is accepted.\n\n`,
    "To regenerate the separate notices file with that Bun, run `bun run check:compiled-binary-notices`; this writes `dist/THIRD_PARTY_NOTICES.md`. Plain compilation does not generate notices.\n\n",
    "For a host-matching target, Bun's compiler copies the running Bun executable, so the rebuilt Lando uses your modified runtime. Cross-target builds download the corresponding released Bun instead: rebuild natively on the target platform to relink it. The embedded container helper is Go, not Bun, so relinking JavaScriptCore doesn't involve it.\n\n",
    `## Bundled npm packages\n\n${packages.length} packages. License and notice file contents below are copied verbatim from the installed packages.\n\n`,
    ...packages.map(renderPackageLicense),
  ];
  await Bun.write(outfile, parts.join("\n"));
  console.log(
    `[compiled-binary-notices] ${packages.length} packages; licenses: ${[...new Set(packages.map((pkg) => pkg.license))].sort().join(", ")}; wrote ${outfile}`,
  );
};
