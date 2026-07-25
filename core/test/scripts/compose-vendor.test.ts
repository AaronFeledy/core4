import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { verifyComposeVendorChecksum } from "../../../scripts/compose-vendor.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const pinPath = resolve(repoRoot, "spec/compose/vendor/pin.json");
const schemaPath = resolve(repoRoot, "spec/compose/vendor/compose-spec.json");

describe("compose vendor checksum", () => {
  test("matches the committed compose-go pin", async () => {
    expect(await verifyComposeVendorChecksum({ pinPath, schemaPath })).toMatchObject({ ok: true });
  });

  test("detects altered vendored bytes without network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-compose-vendor-"));
    const alteredSchemaPath = join(root, "compose-spec.json");

    try {
      await writeFile(alteredSchemaPath, "{}\n", "utf8");
      expect(await verifyComposeVendorChecksum({ pinPath, schemaPath: alteredSchemaPath })).toMatchObject({
        ok: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
