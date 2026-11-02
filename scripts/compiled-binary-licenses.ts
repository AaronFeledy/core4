import { readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";

const PackageMetadata = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  license: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.Union([Schema.String, Schema.Struct({ url: Schema.String })])),
  homepage: Schema.optional(Schema.String),
});

export class CompiledBinaryLicenseError extends Error {
  override readonly name = "CompiledBinaryLicenseError";
}

const PERMISSIVE_LICENSES = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Zlib",
  "Python-2.0",
]);

export const isPermissiveLicense = (expression: string): boolean => {
  const tokens = expression.match(/[A-Za-z0-9.-]+|\S/g) ?? [];
  let index = 0;
  const primary = (): boolean => {
    const token = tokens[index++];
    if (token === "(") {
      if (!compound() || tokens[index++] !== ")") return false;
      return true;
    }
    return token !== undefined && PERMISSIVE_LICENSES.has(token);
  };
  const compound = (): boolean => {
    if (!primary()) return false;
    while (tokens[index] === "OR" || tokens[index] === "AND") {
      index++;
      if (!primary()) return false;
    }
    return true;
  };
  return compound() && index === tokens.length;
};

export interface PackageLicense {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly repository?: string;
  readonly homepage?: string;
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

export const discoverBundledPackageRoots = async (
  metafile: Pick<Bun.BuildMetafile, "outputs">,
  cwd: string,
): Promise<readonly string[]> => {
  const roots = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (contribution.bytesInOutput === 0) continue;
      const normalized = input.replaceAll("\\", "/");
      const matches = [...normalized.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
      const match = matches.at(-1);
      if (match === undefined) continue;
      const packageRoot = await realpath(resolve(cwd, normalized.slice(0, match.index + match[0].length)));
      if (roots.has(packageRoot)) continue;
      const metadata = Schema.decodeUnknownSync(PackageMetadata)(
        await Bun.file(resolve(packageRoot, "package.json")).json(),
      );
      if (
        metadata.name.startsWith("@lando/") &&
        !packageRoot.replaceAll("\\", "/").includes("/node_modules/")
      )
        continue;
      roots.add(packageRoot);
    }
  }
  return [...roots].sort();
};

export const readPackageLicense = async (root: string): Promise<PackageLicense> => {
  const metadata = Schema.decodeUnknownSync(PackageMetadata)(
    await Bun.file(resolve(root, "package.json")).json(),
  );
  const files: { path: string; text: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /^(?:LICENSE|LICENCE|COPYING|NOTICE)/i.test(entry.name)) {
        files.push({ path, text: await Bun.file(resolve(root, path)).text() });
      }
    }
  };
  await visit("");
  if (metadata.license === undefined && files.length === 0) {
    throw new CompiledBinaryLicenseError(
      `${metadata.name}@${metadata.version}: missing license field and license files.`,
    );
  }
  if (metadata.license === undefined || !isPermissiveLicense(metadata.license)) {
    throw new CompiledBinaryLicenseError(
      `${metadata.name}@${metadata.version}: disallowed or undeclared SPDX license ${metadata.license ?? "(missing)"}.`,
    );
  }
  const repository = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
  return {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    ...(repository === undefined ? {} : { repository }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
};

export const renderPackageLicense = (pkg: PackageLicense): string => {
  const parts = [`## ${pkg.name}@${pkg.version}\n\nSPDX: ${pkg.license}\n`];
  if (pkg.repository !== undefined) parts.push(`Repository: ${pkg.repository}\n`);
  if (pkg.homepage !== undefined) parts.push(`Homepage: ${pkg.homepage}\n`);
  if (pkg.files.length === 0)
    parts.push(
      "\nNo license file is shipped in this installed package; see the SPDX declaration and source above.\n",
    );
  for (const file of pkg.files) {
    const fence = "`".repeat(
      Math.max(3, ...[...file.text.matchAll(/`+/g)].map((match) => match[0].length + 1)),
    );
    parts.push(`\n### ${file.path}\n\n${fence}text\n${file.text}\n${fence}\n`);
  }
  return parts.join("");
};
