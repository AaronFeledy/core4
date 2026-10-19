import { resolve } from "node:path";
import { isJsonObject } from "../../../scripts/schema-compatibility/model.ts";
import { schemaAt } from "./x-extension-closed-record.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

export const typedCapture = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-wire.typed-614.json")).json(),
);
if (typeof typedCapture.gzipBase64 !== "string") throw new Error("Missing typed checkpoint bytes");
export const typedBytes = Bun.gunzipSync(Buffer.from(typedCapture.gzipBase64, "base64"));
const payload = wireObject(JSON.parse(new TextDecoder().decode(typedBytes)));
const input = wireObject(payload.input);
if (!Array.isArray(input.anyOf)) throw new Error("Missing typed checkpoint input union");
const documentSet = wireObject(
  input.anyOf.find(
    (branch) =>
      isJsonObject(branch) &&
      isJsonObject(branch.properties) &&
      "currentLowerV4Fragments" in branch.properties,
  ),
);
export const typedCaptured = {
  input,
  fragment: schemaAt(documentSet, "$.currentLowerV4Fragments.items.fragment"),
  services: wireObject(payload.services),
};
