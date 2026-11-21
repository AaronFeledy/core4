import { ArchiveFormatError } from "@lando/sdk/errors";
import { TAR_BLOCK_SIZE as blockSize } from "./tar.ts";
import {
  fieldText,
  hasSymlinkParent,
  hasUstarMagic,
  headerChecksum,
  normalizeMemberPath,
  parseNumeric,
  parsePaxRecords,
} from "./tar-header.ts";
import { isReservedVolumeEntry } from "./volume-archive-reserved.ts";

const decoder = new TextDecoder();
const maxMetadataBytes = 1024 * 1024;

const volumeArchiveError = (path: string, message: string, cause?: unknown): ArchiveFormatError =>
  new ArchiveFormatError({
    message,
    format: "tar",
    archivePath: path,
    ...(cause === undefined ? {} : { cause }),
    remediation: "Recreate the volume archive and retry the transfer.",
  });

const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0);

type WalkerState = "header" | "payload" | "padding" | "done";

/**
 * Streaming tar walker for whole-volume archives. It validates every header and
 * extended-header record before the gate forwards those bytes, so unsafe member
 * paths, reserved Lando names, external hardlinks, and truncated members never
 * reach the extractor.
 */
export class VolumeArchiveWalker {
  readonly #path: string;
  readonly #declared = new Set<string>();
  readonly #symlinks = new Set<string>();
  #buffer = new Uint8Array();
  #state: WalkerState = "header";
  #payloadRemaining = 0;
  #paddingRemaining = 0;
  #metadata: Uint8Array[] | undefined;
  #metadataSize = 0;
  #metadataType: "L" | "K" | "x" | "g" | undefined;
  #pendingMetadata = false;
  #sawInput = false;
  #longName: string | undefined;
  #longLink: string | undefined;
  #paxPath: string | undefined;
  #paxLink: string | undefined;
  #received = 0;
  #safe = 0;

  constructor(path: string) {
    this.#path = path;
  }

  /** Absolute count of input bytes fully validated and safe to forward. */
  get validatedBytes(): number {
    return this.#safe;
  }

  /** True once the archive's end blocks were seen; later input is ignored. */
  get done(): boolean {
    return this.#state === "done";
  }

  #consumed(): number {
    return this.#received - this.#buffer.byteLength;
  }

  #fail(message: string, cause?: unknown): never {
    throw volumeArchiveError(this.#path, message, cause);
  }

  push(chunk: Uint8Array): void {
    if (this.#state === "done" || chunk.byteLength === 0) return;
    this.#sawInput = true;
    this.#received += chunk.byteLength;
    const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    combined.set(this.#buffer);
    combined.set(chunk, this.#buffer.byteLength);
    this.#buffer = combined;
    this.#drain();
  }

  #drain(): void {
    while (true) {
      if (this.#state === "done") {
        this.#buffer = new Uint8Array();
        return;
      }
      if (this.#state === "header") {
        if (this.#buffer.byteLength < blockSize) return;
        const header = this.#buffer.subarray(0, blockSize);
        this.#buffer = this.#buffer.subarray(blockSize);
        if (isZeroBlock(header)) {
          this.#state = "done";
          this.#safe = this.#consumed();
          continue;
        }
        this.#readHeader(header);
        this.#safe = this.#consumed();
        continue;
      }
      if (this.#state === "payload") {
        if (this.#buffer.byteLength === 0) return;
        const take = Math.min(this.#buffer.byteLength, this.#payloadRemaining);
        if (this.#metadata !== undefined) this.#appendMetadata(this.#buffer.subarray(0, take));
        this.#buffer = this.#buffer.subarray(take);
        this.#payloadRemaining -= take;
        if (this.#metadata === undefined) this.#safe += take;
        if (this.#payloadRemaining > 0) return;
        const wasMetadata = this.#metadataType !== undefined;
        this.#finishMember();
        if (wasMetadata) this.#safe = this.#consumed();
        continue;
      }
      if (this.#buffer.byteLength === 0) return;
      const take = Math.min(this.#buffer.byteLength, this.#paddingRemaining);
      this.#buffer = this.#buffer.subarray(take);
      this.#paddingRemaining -= take;
      this.#safe += take;
      if (this.#paddingRemaining > 0) return;
      this.#state = "header";
    }
  }

  #appendMetadata(bytes: Uint8Array): void {
    this.#metadataSize += bytes.byteLength;
    if (this.#metadataSize > maxMetadataBytes) this.#fail("Archive metadata entry is too large.");
    this.#metadata?.push(bytes);
  }

  #readHeader(header: Uint8Array): void {
    const expected = parseNumeric(header.subarray(148, 156));
    if (!Number.isSafeInteger(expected) || expected !== headerChecksum(header)) {
      this.#fail("Archive header checksum does not match its bytes.");
    }
    if (!hasUstarMagic(header)) this.#fail("Archive header magic is not ustar.");
    for (const [label, start, length] of [
      ["mode", 100, 8],
      ["uid", 108, 8],
      ["gid", 116, 8],
      ["size", 124, 12],
      ["mtime", 136, 12],
      ["devmajor", 329, 8],
      ["devminor", 337, 8],
    ] as const) {
      const value = parseNumeric(header.subarray(start, start + length));
      if (!Number.isSafeInteger(value) || value < 0) {
        this.#fail(`Archive ${label} is not a valid tar number.`);
      }
    }
    const size = parseNumeric(header.subarray(124, 136));
    const typeByte = header[156] ?? 0;
    const typeflag = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    if (!["0", "1", "2", "3", "4", "5", "6", "L", "K", "x", "g"].includes(typeflag)) {
      this.#fail(`Archive member type ${JSON.stringify(typeflag)} is not supported.`);
    }
    const prefix = fieldText(header, 345, 155);
    const name = fieldText(header, 0, 100);
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const linkname = fieldText(header, 157, 100);
    this.#payloadRemaining = size;
    this.#paddingRemaining = (blockSize - (size % blockSize)) % blockSize;
    this.#metadataSize = 0;
    if (typeflag === "L" || typeflag === "K" || typeflag === "x" || typeflag === "g") {
      this.#metadataType = typeflag;
      this.#metadata = [];
      this.#state = size === 0 ? "header" : "payload";
      if (size === 0) this.#finishMember();
    } else {
      // Zero-size metadata completed above; clear any other metadata state.
      this.#metadataType = undefined;
      this.#metadata = undefined;
      this.#declareMember(typeflag, fullName, linkname);
      this.#state = size === 0 ? (this.#paddingRemaining === 0 ? "header" : "padding") : "payload";
    }
  }

  #declareMember(typeflag: string, headerName: string, headerLink: string): void {
    const rawName = this.#paxPath ?? this.#longName ?? headerName;
    const rawLink = this.#paxLink ?? this.#longLink ?? headerLink;
    this.#pendingMetadata = false;
    this.#paxPath = undefined;
    this.#paxLink = undefined;
    this.#longName = undefined;
    this.#longLink = undefined;
    if (rawName.includes("\0") || rawLink.includes("\0")) {
      this.#fail("Archive member name or link target contains NUL.");
    }
    const parts = normalizeMemberPath(rawName);
    const rootEntry = parts !== undefined && parts.length === 0;
    if (parts === undefined || (rootEntry && !(typeflag === "5" && (rawName === "." || rawName === "./")))) {
      this.#fail(`Archive member path ${JSON.stringify(rawName)} is not a safe relative path.`);
    }
    const normalized = parts.join("/");
    const first = parts[0];
    if (first !== undefined && isReservedVolumeEntry(first)) {
      this.#fail(`Archive member path ${JSON.stringify(rawName)} is reserved for volume ownership.`);
    }
    if (hasSymlinkParent(parts, this.#symlinks)) {
      this.#fail(`Archive member path ${JSON.stringify(rawName)} traverses a declared symlink.`);
    }
    if (typeflag === "1") {
      const target = normalizeMemberPath(rawLink);
      if (target === undefined || !this.#declared.has(target.join("/"))) {
        this.#fail(`Archive hardlink target ${JSON.stringify(rawLink)} is not inside the archive.`);
      }
    }
    if (typeflag === "2") {
      if (rawLink.length === 0) this.#fail(`Archive symlink ${JSON.stringify(rawName)} has no target.`);
      this.#symlinks.add(normalized);
    }
    if (!rootEntry) this.#declared.add(normalized);
  }

  #finishMember(): void {
    if (this.#metadataType !== undefined) {
      const payload = new Uint8Array(this.#metadataSize);
      let offset = 0;
      for (const chunk of this.#metadata ?? []) {
        payload.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const type = this.#metadataType;
      if (type === "L") this.#longName = decoder.decode(payload).replace(/\0+$/u, "");
      if (type === "K") this.#longLink = decoder.decode(payload).replace(/\0+$/u, "");
      if (type === "x" || type === "g") {
        let globalOverride = false;
        const parsed = parsePaxRecords(payload, (key, value) => {
          if (key !== "path" && key !== "linkpath") return;
          if (type === "g") globalOverride = true;
          else if (key === "path") this.#paxPath = value;
          else this.#paxLink = value;
        });
        if (!parsed) this.#fail("Archive pax header is malformed.");
        // The extractor ignores global name overrides, so validating against them would
        // check names other than the ones it writes.
        if (globalOverride) this.#fail("Archive global pax header overrides member names.");
      }
      this.#metadata = undefined;
      this.#metadataType = undefined;
      this.#metadataSize = 0;
      this.#pendingMetadata = true;
    }
    this.#state = this.#paddingRemaining === 0 ? "header" : "padding";
  }

  finish(): void {
    if (this.#pendingMetadata) {
      this.#fail("Archive ends after a metadata header with no following member.");
    }
    if (this.#state === "done") {
      this.#safe = this.#received;
      return;
    }
    if (!this.#sawInput) this.#fail("Archive is empty.");
    if (this.#state === "payload") this.#fail("Archive member is truncated.");
    if (this.#state === "padding") this.#fail("Archive ends inside member padding.");
    if (this.#buffer.byteLength > 0) this.#fail("Archive ends inside a header block.");
  }
}
