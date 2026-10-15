import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { schemaAt } from "./x-extension-closed-record.ts";

/** Capture complete wire subtrees from a generated checkout at the named revision. */
const base = process.argv[2];
if (base === undefined) throw new Error("Pass the generated historical checkout root");
const profile = process.argv[3] ?? "base";
if (profile !== "base" && profile !== "directives") throw new Error("Unknown wire capture profile");
const provenanceCommit = process.argv[4] ?? "15133ee26729942dde7b9d4f0e033b4ced46406d";
const load = async (name: string) => {
  const value: unknown = await Bun.file(resolve(base, `dist/schemas/${name}.json`)).json();
  if (!isJsonObject(value)) throw new Error(`Invalid historical schema: ${name}`);
  return normalizeJsonSchema(value);
};
const input = await load("config-translate-input");
const encode = await load("config-translate-encode-input");
const fragment = schemaAt(encode, "$.fragment");
for (const [name, path] of [
  ["config-translate-document-set-input", "$.currentLowerV4Fragments.items.fragment"],
  ["config-translate-layer-fragment", "$.fragment"],
  ["config-translate-output", "$.fragment"],
  ["config-translate-result", "$.outputs.items.fragment"],
  ["recipe-decompose-result", "$.fragment"],
] as const) {
  if (!jsonEquals(fragment, schemaAt(await load(name), path))) {
    throw new Error(`Historical fragment differs: ${name} ${path}`);
  }
}
const branches = input.anyOf;
if (!Array.isArray(branches)) throw new Error("Missing historical input union");
const documentSet = branches.find(
  (branch) =>
    isJsonObject(branch) && isJsonObject(branch.properties) && "currentLowerV4Fragments" in branch.properties,
);
if (
  !isJsonObject(documentSet) ||
  !jsonEquals(fragment, schemaAt(documentSet, "$.currentLowerV4Fragments.items.fragment"))
) {
  throw new Error("Historical input union fragment differs");
}
const json = JSON.stringify({ input, services: schemaAt(encode, "$.context.services") });
await Bun.write(
  resolve(import.meta.dirname, `fixtures/x-extension-wire.${profile}.json`),
  `${JSON.stringify(
    {
      provenanceCommit,
      capture:
        "Complete normalized ConfigTranslateInput and ConfigTranslateEncodeInput.context.services; the shared fragment occurs once in input. UTF-8 JSON, gzip, base64. No repair applied. Reproduce with x-extension-wire-capture.ts <generated checkout> <profile> <commit>.",
      sha256: createHash("sha256").update(json).digest("hex"),
      gzipBase64: Buffer.from(Bun.gzipSync(json)).toString("base64"),
    },
    null,
    2,
  )}\n`,
);
