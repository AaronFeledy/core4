/**
 * Minimal X.509 builder for the in-memory test certificate authority.
 *
 * Test worlds need leaves for arbitrary name sets without a host tool, so this module signs real
 * certificates with an ephemeral EC P-256 key pair using `node:crypto` and a hand-rolled DER
 * encoder. It owns encoding and signing only; `minting-certificate-authority.ts` adapts it to the
 * `CertificateAuthority` service and the Effect `Clock`.
 */
import { type KeyObject, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isIP } from "node:net";

import type { CertificateSpec } from "../services/certificate-authority.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Comfortably beyond three times the 30-day `LEAF_RENEWAL_MARGIN_MS`. */
const LEAF_LIFETIME_MS = 365 * DAY_MS;
// The root is created before any Effect Clock is available, so it gets a fixed 2000-2100 window
// instead of one derived from the wall clock; leaves issued under a TestClock set inside that
// window stay inside their issuer's validity.
const ROOT_NOT_BEFORE_MS = Date.UTC(2000, 0, 1);
const ROOT_NOT_AFTER_MS = Date.UTC(2100, 0, 1);

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((size, part) => size + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const lengthBytes = (length: number): Uint8Array => {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: Array<number> = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
};

const tlv = (tag: number, content: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(tag), lengthBytes(content.length), content);

const sequence = (...children: ReadonlyArray<Uint8Array>): Uint8Array => tlv(0x30, concat(...children));
const setOf = (...children: ReadonlyArray<Uint8Array>): Uint8Array => tlv(0x31, concat(...children));
const octetString = (content: Uint8Array): Uint8Array => tlv(0x04, content);
const explicit = (index: number, content: Uint8Array): Uint8Array => tlv(0xa0 | index, content);
const contextPrimitive = (index: number, content: Uint8Array): Uint8Array => tlv(0x80 | index, content);
const boolean = (value: boolean): Uint8Array => tlv(0x01, Uint8Array.of(value ? 0xff : 0x00));

const integer = (value: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.slice(start);
  const first = trimmed[0] ?? 0;
  return tlv(0x02, first >= 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed);
};

const bitString = (value: Uint8Array, unusedBits = 0): Uint8Array =>
  tlv(0x03, concat(Uint8Array.of(unusedBits), value));

const utf8String = (value: string): Uint8Array => tlv(0x0c, new TextEncoder().encode(value));

const oid = (dotted: string): Uint8Array => {
  const arcs = dotted.split(".").map((arc) => Number.parseInt(arc, 10));
  const [first = 0, second = 0, ...rest] = arcs;
  const bytes: Array<number> = [first * 40 + second];
  for (const arc of rest) {
    const encoded: Array<number> = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      encoded.unshift(0x80 | (remaining & 0x7f));
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...encoded);
  }
  return tlv(0x06, Uint8Array.from(bytes));
};

const time = (epochMs: number): Uint8Array => {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  if (year >= 1950 && year <= 2049) return tlv(0x17, new TextEncoder().encode(`${pad(year % 100)}${rest}`));
  return tlv(0x18, new TextEncoder().encode(`${pad(year, 4)}${rest}`));
};

const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

const commonName = (value: string): Uint8Array =>
  sequence(setOf(sequence(oid("2.5.4.3"), utf8String(value))));

const extension = (id: string, critical: boolean, value: Uint8Array): Uint8Array =>
  sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));

const basicConstraints = (isCa: boolean): Uint8Array =>
  extension("2.5.29.19", true, isCa ? sequence(boolean(true)) : sequence());

/** One-byte key-usage bitset: bit 0 is digitalSignature, bits 5/6 are keyCertSign/cRLSign. */
const keyUsage = (usage: {
  readonly digitalSignature?: boolean;
  readonly certificateSigning?: boolean;
}): Uint8Array => {
  let bits = 0;
  if (usage.digitalSignature === true) bits |= 0x80;
  if (usage.certificateSigning === true) bits |= 0x06;
  const unused = bits === 0 ? 7 : 31 - Math.clz32(bits & -bits);
  return extension("2.5.29.15", true, bitString(Uint8Array.of(bits), unused));
};

const serverAuthUsage = (): Uint8Array => extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1")));

const subjectKeyIdentifier = (identifier: Uint8Array): Uint8Array =>
  extension("2.5.29.14", false, octetString(identifier));

const authorityKeyIdentifier = (identifier: Uint8Array): Uint8Array =>
  extension("2.5.29.35", false, sequence(contextPrimitive(0, identifier)));

const ipv6Bytes = (address: string): Uint8Array => {
  const plain = address.replace(/%.*$/u, "");
  const [left = "", right] = plain.split("::");
  const leftGroups = left === "" ? [] : left.split(":");
  const rightGroups = right === undefined || right === "" ? [] : right.split(":");
  const expandGroup = (group: string): Array<string> => {
    if (!group.includes(".")) return [group];
    const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map((part) => Number.parseInt(part, 10));
    return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
  };
  const head = leftGroups.flatMap(expandGroup);
  const tail = rightGroups.flatMap(expandGroup);
  const missing = Math.max(0, 8 - head.length - tail.length);
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  const out = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    out[index * 2] = (value >> 8) & 0xff;
    out[index * 2 + 1] = value & 0xff;
  });
  return out;
};

const ipBytes = (address: string): Uint8Array => {
  if (isIP(address) === 6) return ipv6Bytes(address);
  const [a = 0, b = 0, c = 0, d = 0] = address.split(".").map((part) => Number.parseInt(part, 10));
  return Uint8Array.of(a, b, c, d);
};

const generalName = (value: string): Uint8Array =>
  isIP(value) === 0
    ? contextPrimitive(2, new TextEncoder().encode(value))
    : contextPrimitive(7, ipBytes(value));

const subjectAltName = (names: ReadonlyArray<string>): Uint8Array =>
  extension("2.5.29.17", false, sequence(...names.map(generalName)));

const pemEncode = (der: Uint8Array): string =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der)
    .toString("base64")
    .replace(/.{1,64}/gu, "$&\n")
    .trimEnd()}\n-----END CERTIFICATE-----\n`;

interface KeyMaterial {
  readonly privateKey: KeyObject;
  /** DER SubjectPublicKeyInfo, already a complete TLV. */
  readonly spki: Uint8Array;
}

const generateKey = (): KeyMaterial => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, spki: new Uint8Array(publicKey.export({ type: "spki", format: "der" })) };
};

const keyIdentifier = (key: KeyMaterial): Uint8Array =>
  new Uint8Array(createHash("sha1").update(key.spki).digest());

const signCertificate = (input: {
  readonly issuer: Uint8Array;
  readonly subject: Uint8Array;
  readonly key: KeyMaterial;
  readonly signingKey: KeyObject;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly extensions: Uint8Array;
  readonly serial: Uint8Array;
}): Uint8Array => {
  const tbs = sequence(
    explicit(0, integer(Uint8Array.of(2))),
    integer(input.serial),
    ECDSA_WITH_SHA256,
    input.issuer,
    sequence(time(input.notBefore), time(input.notAfter)),
    input.subject,
    input.key.spki,
    explicit(3, sequence(input.extensions)),
  );
  const signature = sign("sha256", tbs, input.signingKey);
  return sequence(tbs, ECDSA_WITH_SHA256, bitString(new Uint8Array(signature)));
};

/** Ephemeral signing root and the identity a leaf needs to chain to it. */
interface X509Authority {
  readonly rootCertificate: string;
  readonly rootSubject: Uint8Array;
  readonly key: KeyMaterial;
  readonly identifier: Uint8Array;
}

interface IssuedX509Leaf {
  readonly certificate: string;
  readonly privateKey: string;
}

export const createX509Authority = (): X509Authority => {
  const key = generateKey();
  const rootSubject = commonName(`Lando in-memory test CA ${randomBytes(4).toString("hex")}`);
  const identifier = keyIdentifier(key);
  const der = signCertificate({
    issuer: rootSubject,
    subject: rootSubject,
    key,
    signingKey: key.privateKey,
    notBefore: ROOT_NOT_BEFORE_MS,
    notAfter: ROOT_NOT_AFTER_MS,
    extensions: concat(
      basicConstraints(true),
      keyUsage({ certificateSigning: true }),
      subjectKeyIdentifier(identifier),
    ),
    serial: randomBytes(16),
  });
  return { rootCertificate: pemEncode(der), rootSubject, key, identifier };
};

export const issueX509Leaf = (
  authority: X509Authority,
  spec: CertificateSpec,
  now: number,
): IssuedX509Leaf => {
  const key = generateKey();
  const der = signCertificate({
    issuer: authority.rootSubject,
    subject: commonName(spec.cn),
    key,
    signingKey: authority.key.privateKey,
    notBefore: now - HOUR_MS,
    notAfter: now + LEAF_LIFETIME_MS,
    extensions: concat(
      basicConstraints(false),
      keyUsage({ digitalSignature: true }),
      serverAuthUsage(),
      subjectAltName([...new Set([spec.cn, ...spec.sans])]),
      subjectKeyIdentifier(keyIdentifier(key)),
      authorityKeyIdentifier(authority.identifier),
    ),
    serial: randomBytes(16),
  });
  return {
    certificate: pemEncode(der),
    privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};
