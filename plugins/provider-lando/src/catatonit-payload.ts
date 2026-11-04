import { sha256Hex } from "@lando/sdk/digest";

import type { CatatonitPackage } from "./catatonit-pins.ts";
import { DebianArchiveError, parseArMembers, parseTarEntries } from "./debian-archive.ts";
import { decompressDebDataTar } from "./debian-decompress.ts";

export { DebianArchiveError };

export const verifyStaticCatatonit = (
  bytes: Uint8Array,
  pkg: Pick<CatatonitPackage, "binarySizeBytes" | "binarySha256" | "elfMachine">,
): void => {
  if (bytes.length !== pkg.binarySizeBytes || sha256Hex(bytes) !== pkg.binarySha256) {
    throw new DebianArchiveError("Catatonit binary digest or size does not match its pin.");
  }
  if (bytes.length < 64 || Buffer.from(bytes.subarray(0, 7)).toString("hex") !== "7f454c46020101") {
    throw new DebianArchiveError("Catatonit must be a little-endian ELF64 executable.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(18, true) !== pkg.elfMachine || view.getUint16(16, true) !== 2) {
    throw new DebianArchiveError("Catatonit ELF architecture or executable type is incorrect.");
  }
  const offset = Number(view.getBigUint64(32, true));
  const size = view.getUint16(54, true);
  const count = view.getUint16(56, true);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 64 ||
    size < 56 ||
    count === 0 ||
    offset + size * count > bytes.length
  ) {
    throw new DebianArchiveError("Catatonit has an invalid ELF program header table.");
  }
  let load = false;
  for (let i = 0; i < count; i++) {
    const type = view.getUint32(offset + i * size, true);
    if (type === 2 || type === 3)
      throw new DebianArchiveError("Catatonit must be static, without PT_DYNAMIC or PT_INTERP.");
    if (type === 1) load = true;
  }
  if (!load) throw new DebianArchiveError("Catatonit has no ELF load segment.");
};

export const extractCatatonit = async (
  deb: Uint8Array,
  pkg: CatatonitPackage,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const data = parseArMembers(deb).filter((member) => member.name.startsWith("data.tar"));
  const member = data[0];
  if (data.length !== 1 || member === undefined)
    throw new DebianArchiveError("Expected exactly one Debian data archive.");
  const tar = await decompressDebDataTar(member.name, member.bytes, {
    maxDecompressedBytes: 4 * 1024 ** 2,
    ...(signal === undefined ? {} : { signal }),
  });
  const wanted = pkg.member.replace(/^\.\//u, "");
  const matches = parseTarEntries(tar).filter((entry) => entry.name.replace(/^\.\//u, "") === wanted);
  const binary = matches[0];
  if (matches.length !== 1 || binary?.kind !== "file" || binary.bytes === undefined) {
    throw new DebianArchiveError(`Expected one regular /${wanted} payload, not an archive link.`);
  }
  return binary.bytes;
};
