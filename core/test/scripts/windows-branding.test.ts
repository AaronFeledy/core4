import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  WINDOWS_BRANDING,
  assertWindowsBranding,
  readIcoImages,
  readWindowsPeResources,
} from "../../../scripts/windows-branding.ts";

const images = [Buffer.from([1, 2, 3]), Buffer.from([4, 5])] as const;
const landoStrings = {
  ProductName: "Lando",
  CompanyName: "Lando Alliance",
  FileDescription: "Lando",
  LegalCopyright: "MIT © Lando Alliance",
  FileVersion: "4.0.0.0",
  ProductVersion: "4.0.0.0",
};
const pad = (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
const versionBlock = (key: string, value: string | Buffer, children: readonly Buffer[] = []): Buffer => {
  const text = typeof value === "string";
  const bytes = text ? Buffer.from(`${value}\0`, "utf16le") : value;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(text ? bytes.length / 2 : bytes.length, 2);
  header.writeUInt16LE(text ? 1 : 0, 4);
  const block = Buffer.concat([
    pad(Buffer.concat([header, Buffer.from(`${key}\0`, "utf16le")])),
    pad(bytes),
    ...children.map(pad),
  ]);
  block.writeUInt16LE(block.length);
  return block;
};

const ico = (): Buffer => {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    directory.writeUInt32LE(image.length, 6 + index * 16 + 8);
    directory.writeUInt32LE(offset, 6 + index * 16 + 12);
    offset += image.length;
  });
  return Buffer.concat([directory, ...images]);
};

type Resource = { readonly id: number | string; readonly data: Buffer };

const groupIcon = (refs: readonly { readonly id: number; readonly size: number }[]): Buffer => {
  const group = Buffer.alloc(6 + refs.length * 14);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(refs.length, 4);
  refs.forEach(({ id, size }, index) => {
    group.writeUInt32LE(size, 6 + index * 14 + 8);
    group.writeUInt16LE(id, 6 + index * 14 + 12);
  });
  return group;
};

// Reverse ids to distinguish group order from resource directory order.
const reversedIcons = {
  icons: images.toReversed().map((data, index) => ({ id: index + 1, data })),
  groups: [
    {
      id: 1,
      data: groupIcon(images.map((image, index) => ({ id: images.length - index, size: image.length }))),
    },
  ],
};

const peFixture = (
  strings: Readonly<Record<string, string>> = landoStrings,
  pe32 = false,
  {
    icons,
    groups,
  }: { readonly icons: readonly Resource[]; readonly groups: readonly Resource[] } = reversedIcons,
): Buffer => {
  const version = versionBlock("VS_VERSION_INFO", Buffer.alloc(52), [
    versionBlock("StringFileInfo", Buffer.alloc(0), [
      versionBlock(
        "040904b0",
        Buffer.alloc(0),
        Object.entries(strings).map(([key, value]) => versionBlock(key, value)),
      ),
    ]),
    versionBlock("VarFileInfo", Buffer.alloc(0), [versionBlock("Translation", Buffer.from([9, 4, 0xb0, 4]))]),
  ]);
  const resources = [
    { type: 3, entries: icons },
    { type: 14, entries: groups },
    { type: 16, entries: [{ id: 1, data: version }] },
  ];
  const section = Buffer.alloc(4096);
  let cursor = 16 + resources.length * 8;
  const allocate = (size: number): number => {
    const offset = cursor;
    cursor += Math.ceil(size / 4) * 4;
    return offset;
  };
  section.writeUInt16LE(resources.length, 14);
  resources.forEach(({ type, entries }, index) => {
    const typeDir = allocate(16 + entries.length * 8);
    section.writeUInt32LE(type, 16 + index * 8);
    section.writeUInt32LE(typeDir + 0x80000000, 20 + index * 8);
    const named = entries.filter((entry) => typeof entry.id === "string").length;
    section.writeUInt16LE(named, typeDir + 12);
    section.writeUInt16LE(entries.length - named, typeDir + 14);
    entries.forEach(({ id, data }, entryIndex) => {
      const languageDir = allocate(24);
      const dataEntry = allocate(16);
      const payload = allocate(data.length);
      if (typeof id === "string") {
        const name = allocate(2 + id.length * 2);
        section.writeUInt16LE(id.length, name);
        section.write(id, name + 2, "utf16le");
        section.writeUInt32LE(name + 0x80000000, typeDir + 16 + entryIndex * 8);
      } else {
        section.writeUInt32LE(id, typeDir + 16 + entryIndex * 8);
      }
      section.writeUInt32LE(languageDir + 0x80000000, typeDir + 20 + entryIndex * 8);
      section.writeUInt16LE(1, languageDir + 14);
      section.writeUInt32LE(1033, languageDir + 16);
      section.writeUInt32LE(dataEntry, languageDir + 20);
      section.writeUInt32LE(0x1000 + payload, dataEntry);
      section.writeUInt32LE(data.length, dataEntry + 4);
      data.copy(section, payload);
    });
  });
  const headers = Buffer.alloc(512);
  headers.write("MZ");
  headers.writeUInt32LE(0x80, 0x3c);
  headers.write("PE\0\0", 0x80);
  headers.writeUInt16LE(1, 0x86);
  headers.writeUInt16LE(240, 0x94);
  headers.writeUInt16LE(pe32 ? 0x10b : 0x20b, 0x98);
  const directories = 0x98 + (pe32 ? 96 : 112);
  headers.writeUInt32LE(16, directories - 4);
  headers.writeUInt32LE(0x1000, directories + 16);
  headers.writeUInt32LE(cursor, directories + 20);
  const sectionHeader = 0x98 + 240;
  headers.write(".rsrc", sectionHeader);
  headers.writeUInt32LE(cursor, sectionHeader + 8);
  headers.writeUInt32LE(0x1000, sectionHeader + 12);
  headers.writeUInt32LE(cursor, sectionHeader + 16);
  headers.writeUInt32LE(512, sectionHeader + 20);
  return Buffer.concat([headers, section.subarray(0, cursor)]);
};

describe("Windows PE branding resources", () => {
  test.each([false, true])("reads ordered icon images and version blocks (PE32=%s)", (pe32) => {
    // Given: real resource directories and nested version blocks in a synthetic PE.
    const exe = peFixture(landoStrings, pe32);
    // When: the reader walks the resource structures.
    const actual = readWindowsPeResources(exe);
    // Then: group order and all StringFileInfo strings survive parsing.
    expect(actual.images).toEqual(images);
    expect(actual.strings).toEqual(landoStrings);
  });
  test("accepts Lando strings and matching ICO images", () => {
    // Given: an executable with Lando resources.
    const exe = peFixture();
    // When / Then: the assertion accepts matching branding.
    expect(() => assertWindowsBranding(exe, ico())).not.toThrow();
  });
  test("rejects Bun-default version strings", () => {
    // Given: matching icons but Bun's product and publisher strings.
    const exe = peFixture({
      ...landoStrings,
      ProductName: "Bun",
      CompanyName: "Oven",
      FileDescription: "Bun",
    });
    // When / Then: failures identify expected and actual resource values.
    expect(() => assertWindowsBranding(exe, ico())).toThrow('ProductName: expected "Lando", got "Bun"');
    expect(() => assertWindowsBranding(exe, ico())).toThrow(
      'CompanyName: expected "Lando Alliance", got "Oven"',
    );
    expect(() => assertWindowsBranding(exe, ico())).toThrow('FileDescription: expected "Lando", got "Bun"');
  });
  test("rejects differing icon bytes", () => {
    // Given: one corrupted image in the reference ICO.
    const reference = ico();
    reference[reference.length - 1] = 99;
    // When / Then: byte-level mismatch fails branding verification.
    expect(() => assertWindowsBranding(peFixture(), reference)).toThrow("Lando icon mismatch");
  });
  test.each([
    ["accepts", images[0], true],
    ["rejects", Buffer.from([9, 9, 9]), false],
  ] as const)("%s Bun's real icon layout by what icon 1 holds", (_, iconOne, branded) => {
    // Given: Bun's named default group listed first with its stale size for icon 1, plus the
    // id-0 group Bun adds for the full lando.ico.
    const exe = peFixture(landoStrings, false, {
      icons: [iconOne, ...images.slice(1)].map((data, index) => ({ id: index + 1, data })),
      groups: [
        { id: "IDI_MYICON", data: groupIcon([{ id: 1, size: 270600 }]) },
        { id: 0, data: groupIcon(images.map((image, index) => ({ id: index + 1, size: image.length }))) },
      ],
    });
    // When: branding is read and asserted.
    const check = () => assertWindowsBranding(exe, ico());
    // Then: the displayed named group decides, so only a Lando image in icon 1 passes.
    expect(readWindowsPeResources(exe).images).toEqual([iconOne]);
    if (branded) expect(check).not.toThrow();
    else expect(check).toThrow("Lando icon mismatch");
  });
  test.each([Buffer.alloc(0), Buffer.from("not a PE"), Buffer.from("MZ")])(
    "rejects invalid or truncated input %j",
    (bytes) => {
      // Given: bytes that cannot contain a valid PE header.
      // When / Then: parsing fails explicitly rather than reading outside the buffer.
      expect(() => readWindowsPeResources(bytes)).toThrow(/Invalid|truncated/);
    },
  );
  test("rejects truncated resource payloads", () => {
    // Given: a valid PE whose resource section is cut short.
    const exe = peFixture();
    // When / Then: the section bounds check rejects it.
    expect(() => readWindowsPeResources(exe.subarray(0, exe.length - 1))).toThrow(/truncated/);
  });
  test("reads all seven repository ICO images", async () => {
    // Given: the actual multi-resolution Lando icon.
    const bytes = await Bun.file(WINDOWS_BRANDING.icon).bytes();
    // When: ICONDIR entries are resolved to image bytes.
    const actual = readIcoImages(bytes);
    // Then: every entry is present in the intended resolution order.
    expect(actual.map((_, index) => bytes[6 + index * 16] || 256)).toEqual([256, 128, 64, 48, 32, 24, 16]);
    expect(actual.every((image) => image.length > 0)).toBe(true);
  });
  test("CLI rejects an unbranded binary before executing it", async () => {
    // Given: a non-PE file passed to the unchanged CI command.
    const directory = await mkdtemp(join(tmpdir(), "lando-branding-smoke-"));
    try {
      const binary = join(directory, "unbranded.exe");
      await Bun.write(binary, "not a PE");
      // When: the actual smoke CLI runs.
      const proc = Bun.spawn([process.execPath, "run", "scripts/smoke-windows-binary.ts", binary], {
        cwd: resolve(import.meta.dirname, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      // Then: branding is mandatory on the CLI path, with a clear failure.
      expect(code).toBe(1);
      expect(stderr).toContain("Invalid PE DOS signature");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
