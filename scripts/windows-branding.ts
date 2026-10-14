import { resolve } from "node:path";

import { CompiledBinaryVersionError } from "./compiled-binary-version.ts";

export const WINDOWS_BRANDING = {
  icon: resolve(import.meta.dirname, "lando.ico"),
  title: "Lando",
  publisher: "Lando Alliance",
  description: "Lando",
  copyright: "MIT © Lando Alliance",
} as const;

export const windowsPeVersion = (version: string): string => {
  const core = /^(\d+\.\d+\.\d+)(?:[-+]|$)/.exec(version)?.[1];
  if (core === undefined || core.split(".").some((part) => Number(part) > 65535)) {
    throw new CompiledBinaryVersionError(`Invalid Windows PE version core: ${version}.`);
  }
  return core;
};

const align4 = (offset: number): number => Math.ceil(offset / 4) * 4;

// All binary reads, including slices, pass through this bounded view.
const binaryView = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (offset: number, size: number): void => {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > bytes.length) {
      throw new Error(`Invalid or truncated PE/ICO data at offset ${offset} (size ${size}).`);
    }
  };
  return {
    u16(offset: number): number {
      range(offset, 2);
      return view.getUint16(offset, true);
    },
    u32(offset: number): number {
      range(offset, 4);
      return view.getUint32(offset, true);
    },
    slice(offset: number, size: number): Uint8Array {
      range(offset, size);
      return bytes.subarray(offset, offset + size);
    },
  };
};

export const readIcoImages = (bytes: Uint8Array): readonly Uint8Array[] => {
  const view = binaryView(bytes);
  if (view.u16(0) !== 0 || view.u16(2) !== 1 || view.u16(4) === 0) {
    throw new Error("Invalid ICO header.");
  }
  const count = view.u16(4);
  view.slice(6, count * 16);
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16;
    return view.slice(view.u32(entry + 12), view.u32(entry + 8));
  });
};

const readVersionStrings = (bytes: Uint8Array): Readonly<Record<string, string>> => {
  const view = binaryView(bytes);
  const decode = (value: Uint8Array): string => Buffer.from(value).toString("utf16le");
  const strings: Record<string, string> = {};
  const walk = (offset: number, limit: number, path: readonly string[]): number => {
    if (path.length > 4 || offset + 6 > limit) throw new Error("Invalid PE version block header.");
    const length = view.u16(offset);
    const end = offset + length;
    if (length < 6 || end > limit) throw new Error("Invalid PE version block length.");
    const valueLength = view.u16(offset + 2);
    const type = view.u16(offset + 4);
    if (type !== 0 && type !== 1) throw new Error("Invalid PE version value type.");
    let cursor = offset + 6;
    const keyStart = cursor;
    while (true) {
      if (cursor + 2 > end) throw new Error("Unterminated PE version block key.");
      const unit = view.u16(cursor);
      cursor += 2;
      if (unit === 0) break;
    }
    const key = decode(view.slice(keyStart, cursor - keyStart - 2));
    if (path.length === 0 && key !== "VS_VERSION_INFO") throw new Error("Invalid VS_VERSIONINFO key.");
    const valueStart = align4(cursor);
    const valueSize = valueLength * (type === 1 ? 2 : 1);
    if (valueSize > 0 && valueStart + valueSize > end) throw new Error("Truncated PE version value.");
    if (path.length === 3 && path[1] === "StringFileInfo") {
      if (type !== 1) throw new Error("Invalid PE version string type.");
      const value = decode(view.slice(valueStart, valueSize)).replace(/\0+$/, "");
      if (Object.hasOwn(strings, key) && strings[key] !== value) {
        throw new Error(`Conflicting PE version string: ${key}.`);
      }
      Object.defineProperty(strings, key, { value, enumerable: true, configurable: true });
    }
    cursor = align4(valueStart + valueSize);
    while (cursor < end) cursor = align4(walk(cursor, end, [...path, key]));
    return end;
  };
  walk(0, bytes.length, []);
  return strings;
};

export const readWindowsPeResources = (
  bytes: Uint8Array,
): {
  readonly images: readonly Uint8Array[];
  readonly strings: Readonly<Record<string, string>>;
} => {
  const view = binaryView(bytes);
  if (view.u16(0) !== 0x5a4d) throw new Error("Invalid PE DOS signature (expected MZ).");
  const pe = view.u32(0x3c);
  if (view.u32(pe) !== 0x4550) throw new Error("Invalid PE signature.");
  view.slice(pe, 24);
  const sectionCount = view.u16(pe + 6);
  const optionalSize = view.u16(pe + 20);
  const optional = pe + 24;
  const header = binaryView(view.slice(optional, optionalSize));
  const magic = header.u16(0);
  let directories: number;
  switch (magic) {
    case 0x20b:
      directories = 112;
      break;
    case 0x10b:
      directories = 96;
      break;
    default:
      throw new Error("Unsupported PE optional header.");
  }
  if (header.u32(directories - 4) < 3) throw new Error("PE has no resource data directory.");
  const resourceRva = header.u32(directories + 16);
  const resourceSize = header.u32(directories + 20);
  const sections = optional + optionalSize;
  view.slice(sections, sectionCount * 40);
  const rvaOffset = (rva: number, size: number): number => {
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sections + index * 40;
      const address = view.u32(section + 12);
      const rawSize = view.u32(section + 16);
      const delta = rva - address;
      if (delta >= 0 && delta + size <= rawSize) {
        const offset = view.u32(section + 20) + delta;
        view.slice(offset, size);
        return offset;
      }
    }
    throw new Error(`PE resource RVA ${rva} (size ${size}) is outside section data.`);
  };
  if (resourceRva === 0 || resourceSize === 0) throw new Error("PE has no resources.");
  const resources = binaryView(view.slice(rvaOffset(resourceRva, resourceSize), resourceSize));
  const directory = (offset: number) => {
    resources.slice(offset, 16);
    const count = resources.u16(offset + 12) + resources.u16(offset + 14);
    resources.slice(offset + 16, count * 8);
    return Array.from({ length: count }, (_, index) => {
      const entry = offset + 16 + index * 8;
      return { id: resources.u32(entry), target: resources.u32(entry + 4) };
    });
  };
  const descend = (target: number): number => {
    if ((target & 0x80000000) === 0) throw new Error("Expected PE resource directory.");
    return target & 0x7fffffff;
  };
  const resource = (type: number, id?: number): Uint8Array => {
    const typeEntry = directory(0).find((entry) => entry.id === type);
    if (typeEntry === undefined) throw new Error(`Missing PE resource type ${type}.`);
    const entries = directory(descend(typeEntry.target));
    const nameEntry = id === undefined ? entries[0] : entries.find((entry) => entry.id === id);
    if (nameEntry === undefined) throw new Error(`Missing PE resource type ${type}, id ${id}.`);
    const language = directory(descend(nameEntry.target))[0];
    if (language === undefined || (language.target & 0x80000000) !== 0) {
      throw new Error("Invalid PE resource language data entry.");
    }
    resources.slice(language.target, 16);
    const rva = resources.u32(language.target);
    const size = resources.u32(language.target + 4);
    return view.slice(rvaOffset(rva, size), size);
  };
  const group = binaryView(resource(14));
  if (group.u16(0) !== 0 || group.u16(2) !== 1 || group.u16(4) === 0) {
    throw new Error("Invalid PE group icon header.");
  }
  const count = group.u16(4);
  group.slice(6, count * 14);
  const images = Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 14;
    const image = resource(3, group.u16(entry + 12));
    if (image.length !== group.u32(entry + 8)) throw new Error("PE group icon image size mismatch.");
    return image;
  });
  return { images, strings: readVersionStrings(resource(16)) };
};

export const assertWindowsBranding = (exeBytes: Uint8Array, icoBytes: Uint8Array): void => {
  const { images, strings } = readWindowsPeResources(exeBytes);
  const expectedImages = readIcoImages(icoBytes);
  const mismatches: string[] = [];
  if (
    images.length !== expectedImages.length ||
    images.some((image, index) => {
      const expected = expectedImages[index];
      return expected === undefined || Buffer.compare(image, expected) !== 0;
    })
  )
    mismatches.push(
      "Lando icon mismatch: group icon images differ from lando.ico in count, bytes, or order.",
    );
  for (const [key, expected] of Object.entries({
    ProductName: WINDOWS_BRANDING.title,
    CompanyName: WINDOWS_BRANDING.publisher,
    FileDescription: WINDOWS_BRANDING.description,
    LegalCopyright: WINDOWS_BRANDING.copyright,
  })) {
    if (strings[key] !== expected) {
      mismatches.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(strings[key])}`);
    }
  }
  if (mismatches.length > 0) throw new Error(mismatches.join("\n"));
};
