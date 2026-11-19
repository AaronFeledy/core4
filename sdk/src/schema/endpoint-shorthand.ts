import { Schema } from "effect";

export const EndpointNetworkProtocol = Schema.Literals(["http", "https", "tcp", "udp"]);

const port = "[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]";
const aliasPrefix = "([A-Za-z0-9][A-Za-z0-9_-]*)=";
const aliasPattern = new RegExp(`^${aliasPrefix}`);
const pattern = new RegExp(
  `^(?:${aliasPrefix})?(${EndpointNetworkProtocol.literals.join("|")}):(${port})(?![\\s\\S])`,
);
export const endpointShorthandAlias = (value: string): string | undefined => aliasPattern.exec(value)?.[1];
export const endpointInputMessage =
  "Expected protocol:port or name=protocol:port (for example, ui=http:8080), or an endpoint object with kind: internal or kind: published.";

export const EndpointShorthand = Schema.String.check(
  Schema.isPattern(pattern, {
    message: endpointInputMessage,
    toJsonSchema: () => ({ pattern: pattern.source }),
  }),
).annotate({
  description: "Internal network listener as protocol:port or name=protocol:port, such as ui=http:8080.",
});

export const parseEndpointShorthand = (value: string) => {
  const match = pattern.exec(value);
  if (match === null) return undefined;
  const [, name, protocol, portText] = match;
  if (!Schema.is(EndpointNetworkProtocol)(protocol)) return undefined;
  return {
    kind: "internal" as const,
    protocol,
    port: Number(portText),
    ...(name === undefined ? {} : { name }),
  };
};
