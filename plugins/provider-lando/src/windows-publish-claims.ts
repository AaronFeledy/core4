type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validIpv4Address = (value: string): boolean => {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255);
};

const tcpLoopbackPort = (expressions: ReadonlyArray<unknown>): number | undefined => {
  let address: string | undefined;
  let port: number | undefined;
  for (const expression of expressions) {
    if (!record(expression) || !record(expression.match)) continue;
    const match = expression.match;
    if (match.op !== "==" || !record(match.left) || !record(match.left.payload)) continue;
    const payload = match.left.payload;
    if (payload.protocol === "ip" && payload.field === "daddr" && typeof match.right === "string") {
      address = match.right;
    }
    if (payload.protocol === "tcp" && payload.field === "dport") {
      if (!Number.isInteger(match.right) || (match.right as number) < 1 || (match.right as number) > 65535) {
        throw new Error("Malformed TCP host port claim");
      }
      port = match.right as number;
    }
  }
  return address === undefined || address === "127.0.0.1" || address === "0.0.0.0" ? port : undefined;
};

/** Netavark host-port NAT claims in the shared WSL network namespace. */
export const windowsPublishClaims = (raw: string): ReadonlyMap<number, ReadonlySet<string>> => {
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed) || !Array.isArray(parsed.nftables)) throw new Error("Malformed nftables ruleset");
  const claims = new Map<number, Set<string>>();
  const jumped = new Map<number, Set<string>>();
  for (const item of parsed.nftables) {
    if (!record(item) || !record(item.rule)) continue;
    const rule = item.rule;
    if (rule.family !== "inet" || rule.table !== "netavark") continue;
    if (typeof rule.chain !== "string" || !Array.isArray(rule.expr))
      throw new Error("Malformed netavark rule");
    const port = tcpLoopbackPort(rule.expr);
    if (port === undefined) continue;
    if (rule.chain === "NETAVARK-HOSTPORT-DNAT") {
      const jumps = rule.expr.filter((part: unknown) => record(part) && record(part.jump));
      if (
        jumps.length !== 1 ||
        !record(jumps[0]) ||
        !record(jumps[0].jump) ||
        typeof jumps[0].jump.target !== "string"
      )
        throw new Error("Malformed host-port jump");
      const chains = jumped.get(port) ?? new Set<string>();
      chains.add(jumps[0].jump.target);
      jumped.set(port, chains);
      continue;
    }
    for (const part of rule.expr) {
      if (!record(part) || !record(part.dnat)) continue;
      const addr = part.dnat.addr;
      if (part.dnat.family !== "ip" || typeof addr !== "string" || !validIpv4Address(addr))
        throw new Error("Malformed DNAT target");
      const targets = claims.get(port) ?? new Set<string>();
      targets.add(addr);
      claims.set(port, targets);
    }
  }
  for (const [port, chains] of jumped) {
    const targets = claims.get(port) ?? new Set<string>();
    for (const chain of chains) {
      const found = parsed.nftables.some(
        (item: unknown) =>
          record(item) &&
          record(item.rule) &&
          item.rule.chain === chain &&
          Array.isArray(item.rule.expr) &&
          tcpLoopbackPort(item.rule.expr) === port &&
          item.rule.expr.some((part: unknown) => record(part) && record(part.dnat)),
      );
      if (!found) targets.add("");
    }
    claims.set(port, targets);
  }
  return claims;
};

/** Every loopback/wildcard TCP destination-NAT claim visible in shared WSL nft state. */
export const windowsSharedDnatClaims = (raw: string): ReadonlyMap<number, ReadonlySet<string>> => {
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed) || !Array.isArray(parsed.nftables)) throw new Error("Malformed nftables ruleset");
  const claims = new Map<number, Set<string>>();
  for (const item of parsed.nftables) {
    if (!record(item) || !record(item.rule) || !Array.isArray(item.rule.expr)) continue;
    const terminals = item.rule.expr.filter(
      (part: unknown) => record(part) && ("dnat" in part || "redirect" in part || "tproxy" in part),
    );
    if (terminals.length === 0) continue;
    const explicitUdp = item.rule.expr.some(
      (part: unknown) =>
        record(part) &&
        record(part.match) &&
        record(part.match.left) &&
        record(part.match.left.payload) &&
        part.match.left.payload.protocol === "udp" &&
        part.match.left.payload.field === "dport",
    );
    const port = tcpLoopbackPort(item.rule.expr);
    if (port === undefined) {
      if (explicitUdp) continue;
      throw new Error("Ambiguous shared destination-NAT port selector");
    }
    for (const part of terminals) {
      if (!record(part) || !record(part.dnat)) {
        const targets = claims.get(port) ?? new Set<string>();
        targets.add("");
        claims.set(port, targets);
        continue;
      }
      const addr = part.dnat.addr;
      const targetPort = part.dnat.port;
      if (
        part.dnat.family !== "ip" ||
        typeof addr !== "string" ||
        !validIpv4Address(addr) ||
        !Number.isInteger(targetPort) ||
        (targetPort as number) < 1 ||
        (targetPort as number) > 65535
      )
        throw new Error("Malformed shared DNAT target");
      const targets = claims.get(port) ?? new Set<string>();
      targets.add(`${addr}:${targetPort}`);
      claims.set(port, targets);
    }
  }
  return claims;
};
