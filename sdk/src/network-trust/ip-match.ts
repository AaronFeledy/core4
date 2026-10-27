const ipv4 = (text: string): number | undefined => {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/u.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
};

const ipv6 = (text: string): ReadonlyArray<number> | undefined => {
  let expanded = text;
  if (text.includes(".")) {
    const tailStart = text.lastIndexOf(":") + 1;
    const tail = ipv4(text.slice(tailStart));
    if (tailStart === 0 || tail === undefined) return undefined;
    expanded = `${text.slice(0, tailStart)}${(tail >>> 16).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  const halves = expanded.split("::");
  if (halves.length > 2) return undefined;
  const [leftHalf = "", rightHalf = ""] = halves;
  const left = leftHalf === "" ? [] : leftHalf.split(":");
  const right = rightHalf === "" ? [] : rightHalf.split(":");
  const count = left.length + right.length;
  if (halves.length === 2 ? count >= 8 : count !== 8) return undefined;
  if (![...left, ...right].every((group) => /^[\da-f]{1,4}$/iu.test(group))) return undefined;
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: 8 - count }, () => 0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ];
};

const ipWords = (text: string): ReadonlyArray<number> | undefined => {
  const host = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  if (host.includes(":")) return ipv6(host);
  const value = ipv4(host);
  return value === undefined ? undefined : [value >>> 16, value & 0xffff];
};

/** Literal-only comparison; IPv4 and IPv6 retain separate address families. */
export const matchesIpPattern = (host: string, pattern: string): boolean => {
  const [address, prefix, extra] = pattern.split("/");
  if (address === undefined || extra !== undefined) return false;
  const network = ipWords(address);
  const candidate = ipWords(host);
  if (network === undefined || candidate === undefined || network.length !== candidate.length) return false;
  const bits = network.length * 16;
  if (prefix !== undefined && !/^\d{1,3}$/u.test(prefix)) return false;
  const prefixBits = prefix === undefined ? bits : Number(prefix);
  if (prefixBits > bits) return false;
  return network.every((word, index) => {
    const significantBits = Math.min(16, Math.max(0, prefixBits - index * 16));
    const mask = (0xffff << (16 - significantBits)) & 0xffff;
    const candidateWord = candidate[index];
    return candidateWord !== undefined && (candidateWord & mask) === (word & mask);
  });
};
