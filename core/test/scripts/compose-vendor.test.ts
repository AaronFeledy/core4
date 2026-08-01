import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildComposeVendorPin,
  composeVendorSourceUrl,
  parseComposeVendorPin,
  selectNewerComposeGoTag,
  sha256Hex,
  verifyComposeVendorChecksum,
} from "../../../scripts/compose-vendor.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const pinPath = resolve(repoRoot, "vendor/compose/pin.json");
const schemaPath = resolve(repoRoot, "vendor/compose/compose-spec.json");

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

describe("compose vendor source url", () => {
  test("derives the enforced compose-go raw schema url for a tag", () => {
    expect(composeVendorSourceUrl("v2.14.0")).toBe(
      "https://raw.githubusercontent.com/compose-spec/compose-go/v2.14.0/schema/compose-spec.json",
    );
  });
});

describe("build compose vendor pin", () => {
  test("computes a pin that round-trips through parseComposeVendorPin", () => {
    const bytes = new TextEncoder().encode('{"hello":"world"}\n').buffer;
    const pin = buildComposeVendorPin("v2.14.0", bytes);

    expect(pin).toEqual({
      tag: "v2.14.0",
      sourceUrl: "https://raw.githubusercontent.com/compose-spec/compose-go/v2.14.0/schema/compose-spec.json",
      sha256: sha256Hex(bytes),
    });
    expect(() => parseComposeVendorPin(pin, "pin.json")).not.toThrow();
  });
});

describe("select newer compose-go tag", () => {
  test("returns the greatest stable candidate strictly newer than the current pin", () => {
    expect(selectNewerComposeGoTag("v2.13.0", ["v2.12.0", "v2.13.0", "v2.14.0", "v2.13.5"])).toBe("v2.14.0");
  });

  test("compares version components numerically, not lexically", () => {
    expect(selectNewerComposeGoTag("v2.9.5", ["v2.10.0", "v2.9.0"])).toBe("v2.10.0");
  });

  test("returns undefined when no candidate is newer", () => {
    expect(selectNewerComposeGoTag("v2.13.0", ["v2.12.0", "v2.13.0"])).toBeUndefined();
  });

  test("returns undefined for an equal-only candidate set", () => {
    expect(selectNewerComposeGoTag("v2.13.0", ["v2.13.0"])).toBeUndefined();
  });

  test("drops pre-release and malformed candidates", () => {
    expect(selectNewerComposeGoTag("v2.13.0", ["v2.14.0-rc.1", "v2.14", "latest", "2.14.0", "v2.15.0"])).toBe(
      "v2.15.0",
    );
  });

  test("throws when the current tag is unparseable", () => {
    expect(() => selectNewerComposeGoTag("nightly", ["v2.14.0"])).toThrow();
  });
});
