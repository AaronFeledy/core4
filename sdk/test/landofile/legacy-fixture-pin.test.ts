import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

type PinFile = {
  readonly vendored: string;
  readonly bytes: number;
  readonly sha256: string;
};

type PinManifest = {
  readonly files: readonly PinFile[];
};

const fixtureDir = join(import.meta.dir, "../fixtures/lando3");
const pinPath = join(fixtureDir, "pin.json");
const noticePath = join(fixtureDir, "NOTICE.md");

const allowedMeta = new Set(["pin.json", "NOTICE.md"]);

const loadPin = async (): Promise<PinManifest> => {
  const pin = (await Bun.file(pinPath).json()) as PinManifest;
  return pin;
};

const sha256Hex = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
};

describe("lando3 corpus fixture pin", () => {
  test("every pinned fixture matches its sha256 and byte length", async () => {
    const pin = await loadPin();
    expect(pin.files.length).toBeGreaterThan(0);

    for (const entry of pin.files) {
      const path = join(fixtureDir, entry.vendored);
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      expect(bytes.byteLength).toBe(entry.bytes);
      expect(sha256Hex(bytes)).toBe(entry.sha256);
    }
  });

  test("no unpinned files sit beside the pin", async () => {
    const pin = await loadPin();
    const pinned = new Set(pin.files.map((f) => f.vendored));
    const entries = await readdir(fixtureDir);

    for (const name of entries) {
      const allowed = pinned.has(name) || allowedMeta.has(name);
      expect(allowed).toBe(true);
    }
  });

  test("the notice names the corpus license", async () => {
    const notice = Bun.file(noticePath);
    expect(await notice.exists()).toBe(true);
    const text = await notice.text();
    expect(text.includes("GPL-3.0-only")).toBe(true);
  });
});
