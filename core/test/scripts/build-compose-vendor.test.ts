import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  ComposeVendorArgsError,
  applyComposeVendorBump,
  parseComposeVendorArgs,
} from "../../../scripts/build-compose-vendor.ts";
import { readComposeVendorPin, sha256Hex } from "../../../scripts/compose-vendor.ts";

describe("compose vendor args", () => {
  test("defaults to verify mode with no arguments", () => {
    expect(parseComposeVendorArgs([])).toEqual({ mode: "verify" });
  });

  test("parses a bump tag from --tag <value>", () => {
    expect(parseComposeVendorArgs(["--tag", "v2.14.0"])).toEqual({ mode: "bump", tag: "v2.14.0" });
  });

  test("parses a bump tag from --tag=<value>", () => {
    expect(parseComposeVendorArgs(["--tag=v2.14.0"])).toEqual({ mode: "bump", tag: "v2.14.0" });
  });

  test("rejects --tag without a value", () => {
    expect(() => parseComposeVendorArgs(["--tag"])).toThrow();
  });

  test.each(["2.14.0", "v2", "v2.14", "v2.14.0-rc.1", "v2.14.0/schema"])(
    "rejects non-stable compose-go tag %s",
    (tag) => {
      expect(() => parseComposeVendorArgs(["--tag", tag])).toThrow(ComposeVendorArgsError);
    },
  );
});

describe("apply compose vendor bump", () => {
  test("rewrites the pin and schema from injected bytes without network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-compose-bump-"));
    const pinPath = join(root, "pin.json");
    const schemaPath = join(root, "compose-spec.json");
    const bytes = new TextEncoder().encode('{"schema":"contents"}\n').buffer;

    try {
      await applyComposeVendorBump({ tag: "v2.14.0", bytes, pinPath, schemaPath });

      const pin = await readComposeVendorPin(pinPath);
      expect(pin).toEqual({
        tag: "v2.14.0",
        sourceUrl:
          "https://raw.githubusercontent.com/compose-spec/compose-go/v2.14.0/schema/compose-spec.json",
        sha256: sha256Hex(bytes),
      });
      expect(await Bun.file(schemaPath).arrayBuffer()).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
