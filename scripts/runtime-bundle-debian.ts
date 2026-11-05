/**
 * Debian .deb component extraction for runtime-bundle assembly.
 *
 * Reuses the provider-lando ar/tar/decompress parsers (bounded). Build tooling
 * only — runtime packages must not import this module.
 */
import { createHash } from "node:crypto";
import { verifyStaticCatatonit } from "../plugins/provider-lando/src/catatonit-payload.ts";

import {
  DebianArchiveError,
  parseArMembers,
  parseTarEntries,
} from "../plugins/provider-lando/src/debian-archive.ts";
import { decompressDebDataTar } from "../plugins/provider-lando/src/debian-decompress.ts";
import type { RuntimeBundleDebianComponent } from "./runtime-bundle-sources.ts";

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const normalizeMember = (name: string): string => name.replace(/^\.\//u, "");

export const extractDebianRegularMember = async (
  deb: Uint8Array,
  member: string,
  options?: { readonly signal?: AbortSignal; readonly maxDecompressedBytes?: number },
): Promise<Uint8Array> => {
  const wanted = normalizeMember(member);
  if (wanted.length === 0 || wanted.includes("..") || wanted.startsWith("/")) {
    throw new DebianArchiveError(`Debian member path is unsafe: ${member}`);
  }
  const dataMembers = parseArMembers(deb).filter((entry) => entry.name.startsWith("data.tar"));
  const data = dataMembers[0];
  if (dataMembers.length !== 1 || data === undefined) {
    throw new DebianArchiveError("Expected exactly one Debian data archive.");
  }
  const tar = await decompressDebDataTar(data.name, data.bytes, {
    maxDecompressedBytes: options?.maxDecompressedBytes ?? 8 * 1024 ** 2,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  const matches = parseTarEntries(tar).filter((entry) => normalizeMember(entry.name) === wanted);
  const binary = matches[0];
  if (matches.length !== 1 || binary?.kind !== "file" || binary.bytes === undefined) {
    throw new DebianArchiveError(
      `Expected one regular Debian member "${wanted}", not a missing entry, duplicate, or symlink.`,
    );
  }
  return binary.bytes;
};

/** Fail closed unless the payload is a static little-endian ELF64 ET_EXEC for the pinned machine. */
export const verifyStaticElfBinary = (bytes: Uint8Array, component: RuntimeBundleDebianComponent): void => {
  verifyStaticCatatonit(bytes, component);
};

export const extractVerifiedDebianBinary = async (
  component: RuntimeBundleDebianComponent,
  deb: Uint8Array,
): Promise<Uint8Array> => {
  if (deb.length !== component.sizeBytes || sha256Hex(deb) !== component.sha256) {
    throw new DebianArchiveError(
      `assemble-runtime-bundle: ${component.name} package sha256 or size does not match its pin`,
    );
  }
  const bytes = await extractDebianRegularMember(deb, component.member);
  verifyStaticElfBinary(bytes, component);
  return bytes;
};

export { DebianArchiveError };
