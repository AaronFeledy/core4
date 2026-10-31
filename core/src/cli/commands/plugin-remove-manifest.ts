import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NotImplementedError } from "@lando/sdk/errors";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { Schema } from "effect";

const Manifest = Schema.Record(Schema.String, Schema.Unknown);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const manifestError = (path: string, cause: unknown) =>
  new NotImplementedError({
    message: `Managed plugin root package.json is not readable JSON: ${path}.`,
    commandId: "meta:plugin:remove",
    remediation: `Repair or remove ${path}, then retry plugin removal. Cause: ${String(cause)}`,
  });

export const updateManagedRootManifest = async (pluginsRoot: string, name: string): Promise<void> => {
  const path = join(pluginsRoot, "package.json");
  if (!existsSync(path)) return;
  let manifest: typeof Manifest.Type;
  try {
    manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    throw manifestError(path, cause);
  }
  let changed = false;
  for (const field of dependencyFields) {
    const deps = manifest[field];
    if (!Schema.is(Manifest)(deps)) continue;
    if (Object.hasOwn(deps, name)) {
      Reflect.deleteProperty(deps, name);
      changed = true;
    }
  }
  if (changed) await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
};
