import { resolve } from "node:path";

import type { JsonSchema } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { blankContextBody, schemaAt } from "./x-extension-closed-record.ts";
import { configOutputLandofile } from "./x-extension-config-output.ts";
import { type ParityEdit, diffParity, schemaDigest } from "./x-extension-schema-parity-edit.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

const [baseline, candidate, beforeCommit, afterCommit] = process.argv.slice(2);
if (!baseline || !candidate || !beforeCommit || !afterCommit) {
  throw new TypeError(
    "Usage: x-extension-schema-parity-capture.ts <generated base> <generated candidate> <base sha> <candidate sha>",
  );
}

const load = async (root: string, file: string) =>
  normalizeJsonSchema(wireObject(await Bun.file(resolve(root, "dist", file)).json()));

const targets = {
  bare: ["command-schemas/app-config.json", configOutputLandofile],
  services: [
    "schemas/config-translate-encode-input.json",
    (schema) => schemaAt(schema, "$.context.services"),
  ],
  fragment: ["schemas/config-translate-encode-input.json", (schema) => schemaAt(schema, "$.fragment")],
  input: ["schemas/config-translate-input.json", (schema) => schema],
} satisfies Record<string, readonly [string, (schema: JsonSchema) => JsonSchema]>;

const edits: ParityEdit[] = [];
const interned = new Map<string, number>();
const intern = (edit: ParityEdit): number => {
  const key = JSON.stringify(edit);
  const existing = interned.get(key);
  if (existing !== undefined) return existing;
  const id = edits.push(edit) - 1;
  interned.set(key, id);
  return id;
};

const checkpoints = [];
for (const [name, [file, select]] of Object.entries(targets)) {
  const before = select(await load(baseline, file));
  const after = select(await load(candidate, file));
  const edit = diffParity(before, after, intern);
  checkpoints.push([name, { before: schemaDigest(before), after: schemaDigest(after), edit }]);
}

const context = schemaAt(await load(candidate, "schemas/config-translate-encode-input.json"), "$.context");
await Bun.write(
  resolve(import.meta.dirname, "fixtures/x-extension-schema-parity.delta.json"),
  `${JSON.stringify({
    beforeCommit,
    afterCommit,
    reproduction:
      "x-extension-schema-parity-capture.ts <generated base> <generated candidate> <base sha> <candidate sha>",
    contextKeys: Object.keys(wireObject(context.properties)).sort(),
    contextBodySha256: schemaDigest(blankContextBody(context)),
    checkpoints: Object.fromEntries(checkpoints),
    edits,
  })}\n`,
);
