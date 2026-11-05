import type { ListenerObservation } from "@lando/sdk/schema";

type Binding = ListenerObservation["listening"][number];
type ObservedBinding = Binding & { readonly loopback: boolean };

interface DecodedAddress {
  readonly address: string;
  readonly loopback: boolean;
}

/** /proc/net/tcp6 stores an IPv6 address as four host-order 32-bit words. */
const decodeAddress = (hex: string): DecodedAddress | undefined => {
  if (!/^(?:[\dA-F]{8}|[\dA-F]{32})$/iu.test(hex)) return undefined;
  const bytes = (hex.match(/.{8}/gu) ?? []).flatMap((word) =>
    (word.match(/../gu) ?? []).reverse().map((byte) => Number.parseInt(byte, 16)),
  );
  if (bytes.length === 4) return { address: bytes.join("."), loopback: bytes[0] === 127 };
  const groups: string[] = [];
  for (let index = 0; index < bytes.length; index += 2)
    groups.push(((bytes[index] ?? 0) * 256 + (bytes[index + 1] ?? 0)).toString(16));
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const loopback =
    (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) || (mapped && bytes[12] === 127);
  // URL host parsing yields the canonical compressed form, e.g. `::` and `::1`.
  return { address: new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1), loopback };
};

/** Reject incomplete/malformed tables rather than claim a listener is absent. */
export const parseTcpListeners = (stdout: string): readonly ObservedBinding[] | undefined => {
  if (stdout.length === 0 || !stdout.endsWith("\n")) return undefined;
  let headers = 0;
  const bindings = new Map<string, ObservedBinding>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    if (
      /^\s*sl\s+local_address\s+rem(?:ote)?_address\s+st\s+tx_queue\s+rx_queue\s+tr\s+tm->when\s+retrnsmt\s+uid\s+timeout\s+inode\s*$/u.test(
        line,
      )
    ) {
      headers += 1;
      continue;
    }
    const fields = line.trim().split(/\s+/u);
    const [slot, local, remote, state] = fields;
    if (
      headers === 0 ||
      !/^\d+:$/u.test(slot ?? "") ||
      fields.length < 10 ||
      !/^[\dA-F]{2}$/iu.test(state ?? "") ||
      !/^(?:[\dA-F]{8}|[\dA-F]{32}):[\dA-F]{4}$/iu.test(remote ?? "")
    )
      return undefined;
    const match = /^(?<address>[\dA-F]{8}|[\dA-F]{32}):(?<port>[\dA-F]{4})$/iu.exec(local ?? "");
    if (match?.groups === undefined) return undefined;
    const decoded = decodeAddress(match.groups.address ?? "");
    if (decoded === undefined) return undefined;
    if (state?.toUpperCase() !== "0A") continue;
    const port = Number.parseInt(match.groups.port ?? "", 16);
    bindings.set(`${decoded.address}/${port}`, {
      address: decoded.address,
      port,
      loopback: decoded.loopback,
    });
  }
  return headers === 0 ? undefined : [...bindings.values()];
};

export const classifyTcpListeners = (
  expected: Pick<ListenerObservation, "service" | "port" | "basis" | "transport">,
  bindings: readonly ObservedBinding[],
): ListenerObservation => {
  const matching = bindings.filter((binding) => binding.port === expected.port);
  const ordered = [...bindings].sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
  const ports = new Map<number, ObservedBinding>();
  for (const binding of ordered) if (!ports.has(binding.port)) ports.set(binding.port, binding);
  const representatives = [...ports.values()];
  return {
    ...expected,
    state:
      matching.length === 0
        ? "not-listening"
        : matching.every((binding) => binding.loopback)
          ? "loopback-only"
          : "listening",
    listening: [...representatives, ...ordered.filter((binding) => ports.get(binding.port) !== binding)]
      .slice(0, 16)
      .map(({ address, port }) => ({ address, port })),
  };
};
