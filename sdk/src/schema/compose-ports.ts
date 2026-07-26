import { Either, ParseResult, Schema } from "effect";

import { BindAddress } from "./endpoint.ts";
import { PortNumber } from "./primitives.ts";

// ==== Canonical Compose port entries (Compose Specification: services.ports / services.expose) ====

const PortProtocol = Schema.Literal("tcp", "udp");

export const ComposePortEntry = Schema.Struct({
  target: PortNumber,
  published: Schema.optional(PortNumber),
  hostIp: Schema.optional(BindAddress),
  protocol: PortProtocol,
  name: Schema.optional(Schema.String),
  appProtocol: Schema.optional(Schema.String),
});
export type ComposePortEntry = typeof ComposePortEntry.Type;

const ComposePortLongInput = Schema.Struct({
  target: PortNumber,
  published: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  host_ip: Schema.optional(BindAddress),
  protocol: Schema.optional(PortProtocol),
  name: Schema.optional(Schema.String),
  app_protocol: Schema.optional(Schema.String),
});

const decodePort = (value: string | number): PortNumber | undefined => {
  const numeric = typeof value === "number" ? value : Number(value);
  const decoded = Schema.decodeUnknownEither(PortNumber)(numeric);
  return Either.isRight(decoded) ? decoded.right : undefined;
};

const decodePortRange = (value: string): ReadonlyArray<PortNumber> | undefined => {
  const bounds = value.split("-");
  if (bounds.length === 1) {
    const port = decodePort(value);
    return port === undefined ? undefined : [port];
  }
  if (bounds.length !== 2) return undefined;
  const startText = bounds[0];
  const endText = bounds[1];
  if (startText === undefined || endText === undefined) return undefined;
  const start = decodePort(startText);
  const end = decodePort(endText);
  if (start === undefined || end === undefined || start > end) return undefined;
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
};

const decodeHostIp = (value: string): BindAddress | undefined => {
  const bracketed = value.startsWith("[") && value.endsWith("]");
  if (value.includes(":") && !bracketed) return undefined;
  const candidate = bracketed ? value.slice(1, -1) : value;
  const decoded = Schema.decodeUnknownEither(BindAddress)(candidate);
  return Either.isRight(decoded) ? decoded.right : undefined;
};

const parseShortPort = (value: string): Either.Either<ReadonlyArray<ComposePortEntry>, string> => {
  const protocolSeparator = value.lastIndexOf("/");
  const protocolText = protocolSeparator < 0 ? "tcp" : value.slice(protocolSeparator + 1);
  if (protocolText !== "tcp" && protocolText !== "udp") {
    return Either.left(`Unsupported port protocol "${protocolText}"; expected tcp or udp.`);
  }
  const body = protocolSeparator < 0 ? value : value.slice(0, protocolSeparator);
  const targetSeparator = body.lastIndexOf(":");
  const targetText = targetSeparator < 0 ? body : body.slice(targetSeparator + 1);
  const targets = decodePortRange(targetText);
  if (targets === undefined) return Either.left(`Invalid container port or range "${targetText}".`);
  if (targetSeparator < 0) {
    return Either.right(targets.map((target) => ({ target, protocol: protocolText })));
  }

  const host = body.slice(0, targetSeparator);
  const hostSeparator = host.lastIndexOf(":");
  const hostIpText = hostSeparator < 0 ? undefined : host.slice(0, hostSeparator);
  const publishedText = hostSeparator < 0 ? host : host.slice(hostSeparator + 1);
  const hostIp = hostIpText === undefined || hostIpText === "" ? undefined : decodeHostIp(hostIpText);
  if (hostIpText !== undefined && hostIpText !== "" && hostIp === undefined) {
    return Either.left(`Invalid host IP address "${hostIpText}".`);
  }
  if (publishedText === "") {
    return Either.right(
      targets.map((target) => ({
        target,
        ...(hostIp === undefined ? {} : { hostIp }),
        protocol: protocolText,
      })),
    );
  }

  const published = decodePortRange(publishedText);
  if (published === undefined) return Either.left(`Invalid published port or range "${publishedText}".`);
  const hostIsRange = publishedText.includes("-");
  const targetIsRange = targetText.includes("-");
  if (hostIsRange && !targetIsRange) {
    return Either.left(
      "A host port range cannot map to one target; enumerate individual host-port mappings.",
    );
  }
  if (published.length !== targets.length) {
    return Either.left("Published and target port range lengths differ; use equal-length ranges.");
  }
  return Either.right(
    targets.map((target, index) => ({
      target,
      published: published[index],
      ...(hostIp === undefined ? {} : { hostIp }),
      protocol: protocolText,
    })),
  );
};

// ==== Compose ports field — normalize short and long authoring forms ====

const ComposePortInput = Schema.Union(Schema.String, Schema.Number, ComposePortLongInput);

export const ComposePortsField = Schema.transformOrFail(
  Schema.Array(ComposePortInput),
  Schema.Array(ComposePortEntry),
  {
    strict: true,
    decode: (input, _options, ast) => {
      const entries: Array<ComposePortEntry> = [];
      for (const [index, entry] of input.entries()) {
        const fail = (actual: unknown, message: string) =>
          ParseResult.fail(new ParseResult.Pointer(index, input, new ParseResult.Type(ast, actual, message)));
        if (typeof entry === "string") {
          const parsed = parseShortPort(entry);
          if (Either.isLeft(parsed)) return fail(entry, parsed.left);
          entries.push(...parsed.right);
          continue;
        }
        if (typeof entry === "number") {
          const target = decodePort(entry);
          if (target === undefined) return fail(entry, "Expected a port number from 1 through 65535.");
          entries.push({ target, protocol: "tcp" });
          continue;
        }
        if (typeof entry.published === "string" && entry.published.includes("-")) {
          return fail(entry.published, "Published port ranges in long form must enumerate scalar entries.");
        }
        const published = entry.published === undefined ? undefined : decodePort(entry.published);
        if (entry.published !== undefined && published === undefined) {
          return fail(entry.published, "Expected a published port number from 1 through 65535.");
        }
        entries.push({
          target: entry.target,
          ...(published === undefined ? {} : { published }),
          ...(entry.host_ip === undefined ? {} : { hostIp: entry.host_ip }),
          protocol: entry.protocol ?? "tcp",
          ...(entry.name === undefined ? {} : { name: entry.name }),
          ...(entry.app_protocol === undefined ? {} : { appProtocol: entry.app_protocol }),
        });
      }
      return ParseResult.succeed(entries);
    },
    encode: (entries) =>
      ParseResult.succeed(
        entries.map((entry) => ({
          target: entry.target,
          ...(entry.published === undefined ? {} : { published: entry.published }),
          ...(entry.hostIp === undefined ? {} : { host_ip: entry.hostIp }),
          protocol: entry.protocol,
          ...(entry.name === undefined ? {} : { name: entry.name }),
          ...(entry.appProtocol === undefined ? {} : { app_protocol: entry.appProtocol }),
        })),
      ),
  },
);

// ==== Compose expose field — normalize container-only ports and ranges ====

export const ComposeExposeField = Schema.transformOrFail(
  Schema.Array(Schema.Union(Schema.String, Schema.Number)),
  Schema.Array(PortNumber),
  {
    strict: true,
    decode: (input, _options, ast) => {
      const ports: Array<PortNumber> = [];
      for (const [index, entry] of input.entries()) {
        const decoded = typeof entry === "number" ? decodePort(entry) : decodePortRange(entry);
        if (decoded === undefined) {
          return ParseResult.fail(
            new ParseResult.Pointer(
              index,
              input,
              new ParseResult.Type(ast, entry, "Expected a container port or ascending port range."),
            ),
          );
        }
        ports.push(...(typeof decoded === "number" ? [decoded] : decoded));
      }
      return ParseResult.succeed(ports);
    },
    encode: (ports) => ParseResult.succeed(ports),
  },
);
