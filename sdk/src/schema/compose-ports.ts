import { SchemaIssue, SchemaTransformation } from "effect";
import { Effect } from "effect";
import { Result, Schema } from "effect";

import { BindAddress } from "./endpoint.ts";
import { PortNumber } from "./primitives.ts";

const PortProtocol = Schema.Literals(["tcp", "udp"]);
const Forbidden = Schema.optionalKey(Schema.Never);
const DecimalPortToken = /^[0-9]{1,5}$/;

export const ComposePortEntry = Schema.Struct({
  target: PortNumber,
  published: Schema.optionalKey(PortNumber),
  hostIp: Schema.optionalKey(BindAddress),
  protocol: PortProtocol,
  name: Schema.optionalKey(Schema.String),
  appProtocol: Schema.optionalKey(Schema.String),
});
export type ComposePortEntry = typeof ComposePortEntry.Type;

const ComposePortLongInput = Schema.Struct({
  target: PortNumber,
  published: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  host_ip: Schema.optionalKey(BindAddress),
  protocol: Schema.optionalKey(PortProtocol),
  name: Schema.optionalKey(Schema.String),
  app_protocol: Schema.optionalKey(Schema.String),
  hostIp: Forbidden,
  appProtocol: Forbidden,
  mode: Schema.optionalKey(Schema.Never).annotate({ description: "Compose ports.mode is unsupported." }),
});

const ComposePortCanonicalInput = ComposePortEntry.pipe(Schema.fieldsAssign({
    host_ip: Forbidden,
    app_protocol: Forbidden,
    mode: Schema.optionalKey(Schema.Never).annotate({ description: "Compose ports.mode is unsupported." }),
  }));

const decodePort = (value: string | number): PortNumber | undefined => {
  if (typeof value === "string" && !DecimalPortToken.test(value)) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  const decoded = Schema.decodeUnknownResult(PortNumber)(numeric);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
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
  const decoded = Schema.decodeUnknownResult(BindAddress)(candidate);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const parseShortPort = (value: string): Result.Result<ReadonlyArray<ComposePortEntry>, string> => {
  const protocolSeparator = value.lastIndexOf("/");
  const protocolText = protocolSeparator < 0 ? "tcp" : value.slice(protocolSeparator + 1);
  if (protocolText !== "tcp" && protocolText !== "udp") {
    return Result.fail(`Unsupported port protocol "${protocolText}"; expected tcp or udp.`);
  }
  const body = protocolSeparator < 0 ? value : value.slice(0, protocolSeparator);
  const targetSeparator = body.lastIndexOf(":");
  const targetText = targetSeparator < 0 ? body : body.slice(targetSeparator + 1);
  const targets = decodePortRange(targetText);
  if (targets === undefined) return Result.fail(`Invalid container port or range "${targetText}".`);
  if (targetSeparator < 0) {
    return Result.succeed(targets.map((target) => ({ target, protocol: protocolText })));
  }

  const host = body.slice(0, targetSeparator);
  const hostSeparator = host.lastIndexOf(":");
  const hostIpText = hostSeparator < 0 ? undefined : host.slice(0, hostSeparator);
  const publishedText = hostSeparator < 0 ? host : host.slice(hostSeparator + 1);
  const hostIp = hostIpText === undefined || hostIpText === "" ? undefined : decodeHostIp(hostIpText);
  if (hostIpText !== undefined && hostIpText !== "" && hostIp === undefined) {
    return Result.fail(`Invalid host IP address "${hostIpText}".`);
  }
  if (publishedText === "") {
    return Result.succeed(
      targets.map((target) => ({
        target,
        ...(hostIp === undefined ? {} : { hostIp }),
        protocol: protocolText,
      })),
    );
  }

  const published = decodePortRange(publishedText);
  if (published === undefined) return Result.fail(`Invalid published port or range "${publishedText}".`);
  const hostIsRange = publishedText.includes("-");
  const targetIsRange = targetText.includes("-");
  if (hostIsRange && !targetIsRange) {
    return Result.fail(
      "A host port range cannot map to one target; enumerate individual host-port mappings.",
    );
  }
  if (published.length !== targets.length) {
    return Result.fail("Published and target port range lengths differ; use equal-length ranges.");
  }
  return Result.succeed(
    targets.map((target, index) => {
      const publishedPort = published[index];
      return {
      target,
      ...(publishedPort === undefined ? {} : { published: publishedPort }),
      ...(hostIp === undefined ? {} : { hostIp }),
      protocol: protocolText,
    }; }),
  );
};

const ComposePortInput = Schema.Union([Schema.String, Schema.Number, ComposePortLongInput, ComposePortCanonicalInput]);

export const ComposePortsField = Schema.Array(ComposePortInput).pipe(Schema.decodeTo(Schema.Array(ComposePortEntry), SchemaTransformation.transformEffect<ReadonlyArray<typeof ComposePortEntry.Encoded>, ReadonlyArray<typeof ComposePortInput.Type>>({ decode: (input, _options) => {
      const entries: Array<ComposePortEntry> = [];
      for (const [index, entry] of input.entries()) {
        const fail = (actual: unknown, message: string) =>
          Effect.fail(new SchemaIssue.Pointer([index], new SchemaIssue.InvalidValue({ message: message }, actual)));
        if (typeof entry === "string") {
          const parsed = parseShortPort(entry);
          if (Result.isFailure(parsed)) return fail(entry, parsed.failure);
          entries.push(...parsed.success);
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
        const hostIp = entry.hostIp ?? entry.host_ip;
        const appProtocol = entry.appProtocol ?? entry.app_protocol;
        entries.push({
          target: entry.target,
          ...(published === undefined ? {} : { published }),
          ...(hostIp === undefined ? {} : { hostIp }),
          protocol: entry.protocol ?? "tcp",
          ...(entry.name === undefined ? {} : { name: entry.name }),
          ...(appProtocol === undefined ? {} : { appProtocol }),
        });
      }
      return Effect.succeed(entries);
     }, encode: (entries: ReadonlyArray<typeof ComposePortEntry.Encoded>) =>
      Effect.succeed(
        entries.map((entry) => ({
          target: entry.target,
          ...(entry.published === undefined ? {} : { published: entry.published }),
          ...(entry.hostIp === undefined ? {} : { host_ip: entry.hostIp }),
          protocol: entry.protocol,
          ...(entry.name === undefined ? {} : { name: entry.name }),
          ...(entry.appProtocol === undefined ? {} : { app_protocol: entry.appProtocol }),
        })),
      ) })));

export const ComposeExposeField = Schema.Array(Schema.Union([Schema.String, Schema.Number])).pipe(Schema.decodeTo(Schema.Array(PortNumber), SchemaTransformation.transformEffect<ReadonlyArray<typeof PortNumber.Encoded>, ReadonlyArray<string | number>>({ decode: (input, _options) => {
      const ports: Array<PortNumber> = [];
      for (const [index, entry] of input.entries()) {
        const decoded = typeof entry === "number" ? decodePort(entry) : decodePortRange(entry);
        if (decoded === undefined) {
          return Effect.fail(
            new SchemaIssue.Pointer(
              [index],
              new SchemaIssue.InvalidValue({ message: "Expected a container port or ascending port range." }, entry),
            ),
          );
        }
        ports.push(...(typeof decoded === "number" ? [decoded] : decoded));
      }
      return Effect.succeed(ports);
     }, encode: (ports) => Effect.succeed(ports) })));
