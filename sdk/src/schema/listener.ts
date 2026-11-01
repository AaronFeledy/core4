import { Schema } from "effect";

import { EndpointRef } from "./endpoint.ts";
import { PortNumber, ServiceName } from "./primitives.ts";

// ============================================================================
// Listener ownership and bounded socket evidence.
// ============================================================================

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const assertNever = (value: never): never => value;

export const ListenerAuthorityOwner = Schema.Literals(["application", "launcher", "image"]).annotate({
  description:
    "application: app code or command owns a language-runtime listener; launcher: an authored command or entrypoint replaced Lando's launcher; image: a custom image or build owns daemon configuration.",
});
export type ListenerAuthorityOwner = typeof ListenerAuthorityOwner.Type;

export const ListenerAuthority = Schema.Struct({
  owner: ListenerAuthorityOwner.annotate({ description: "Who owns this listener's configuration." }),
  daemon: NonEmptyString.annotate({
    description: "Server whose configuration the owner must supply, not socket attribution.",
  }),
  port: PortNumber.annotate({ description: "Planned service listener port." }),
  setting: Schema.optionalKey(NonEmptyString).annotate({
    description: "Launcher argument or image configuration setting for the planned port.",
  }),
  file: Schema.optionalKey(NonEmptyString).annotate({
    description: "Image-owned file containing the listener setting.",
  }),
  variables: Schema.optionalKey(Schema.NonEmptyArray(NonEmptyString)).annotate({
    description: "Port environment variables Lando projects for application-owned listeners.",
  }),
}).annotate({
  identifier: "ListenerAuthority",
  description: "Structured ownership and configuration advice for a planned listener.",
});
export type ListenerAuthority = typeof ListenerAuthority.Type;

export const ObservedListener = Schema.Struct({
  address: Schema.String.annotate({
    description: "Observed TCP LISTEN bind address, without attributing a process.",
  }),
  port: PortNumber.annotate({ description: "Observed TCP LISTEN port." }),
}).annotate({ identifier: "ObservedListener", description: "One observed TCP LISTEN socket address." });
export type ObservedListener = typeof ObservedListener.Type;

export const ListenerStatus = Schema.Literals([
  "listening",
  "loopback-only",
  "absent",
  "unavailable",
]).annotate({
  description:
    "listening: a TCP LISTEN socket on the planned port binds a wildcard or non-loopback address; loopback-only: only 127/8, ::1, or ::ffff:127/8 binds on it; absent: complete valid tables contain no socket on it; unavailable: exec failure, timeout, missing cat, malformed tables, or partial tables without the port prevent trustworthy observation.",
});
export type ListenerStatus = typeof ListenerStatus.Type;

export const ListenerDiagnosis = Schema.Struct({
  service: ServiceName.annotate({ description: "Service whose network namespace was observed." }),
  endpoint: EndpointRef.annotate({ description: "Planned logical listener being diagnosed." }),
  status: ListenerStatus.annotate({ description: "Classification before observed sockets are capped." }),
  observed: Schema.Array(ObservedListener).annotate({
    description: "Bounded socket evidence, with target-port sockets first.",
  }),
  truncated: Schema.Boolean.annotate({ description: "Whether additional observed sockets were omitted." }),
  authority: Schema.optionalKey(ListenerAuthority).annotate({
    description: "Known ownership and configuration advice for this listener.",
  }),
}).annotate({
  identifier: "ListenerDiagnosis",
  description: "Bounded TCP listener evidence for a planned service endpoint.",
});
export type ListenerDiagnosis = typeof ListenerDiagnosis.Type;

// ============================================================================
// Pure remediation formatting; socket evidence never identifies a daemon.
// ============================================================================

export const formatListenerAuthority = (authority: ListenerAuthority): string => {
  switch (authority.owner) {
    case "launcher":
      return `Lando configures the listener from port: only in its own launcher. Your command or entrypoint must configure it: for ${authority.daemon}, pass \`${authority.setting ?? ""}\`.`;
    case "image":
      return `Lando configures the listener from port: only in configuration it owns. Your image or build must configure it: for ${authority.daemon}, set \`${authority.setting ?? ""}\`${authority.file === undefined ? "" : ` in ${authority.file}`}.`;
    case "application": {
      const variables = (authority.variables ?? []).map((variable) => `\`${variable}\``);
      const list =
        variables.length < 2
          ? variables.join("")
          : `${variables.slice(0, -1).join(", ")} and ${variables.at(-1)}`;
      return `Your application owns this listener. Lando sets ${list} to ${authority.port}; make its server listen on 0.0.0.0:${authority.port}.`;
    }
    default:
      return assertNever(authority.owner);
  }
};

export const formatListenerDiagnosis = (diagnosis: ListenerDiagnosis): string | undefined => {
  const port = diagnosis.endpoint.port;
  switch (diagnosis.status) {
    case "listening":
    case "unavailable":
      return undefined;
    case "loopback-only":
      return `Port ${port} was observed only on loopback (${diagnosis.observed
        .filter((socket) => socket.port === port)
        .map((socket) => `\`${socket.address}\``)
        .join(", ")}). Other containers cannot reach it; configure the server to bind 0.0.0.0.`;
    case "absent": {
      const others = diagnosis.observed.filter((socket) => socket.port !== port);
      return `No TCP listener was observed on planned port ${port}.${others.length === 0 ? " No other TCP listeners were observed." : ` Other TCP listeners: ${others.map((socket) => `\`${socket.address.includes(":") ? `[${socket.address}]` : socket.address}:${socket.port}\``).join(", ")}.`}`;
    }
    default:
      return assertNever(diagnosis.status);
  }
};

export const listenerRemediation = (input: {
  readonly diagnosis?: ListenerDiagnosis;
  readonly authority?: ListenerAuthority;
}): string | undefined => {
  const diagnosis = input.diagnosis === undefined ? undefined : formatListenerDiagnosis(input.diagnosis);
  const authority = input.authority ?? input.diagnosis?.authority;
  const advice =
    input.diagnosis?.status === "listening" || authority === undefined
      ? undefined
      : formatListenerAuthority(authority);
  const sentences = [diagnosis, advice].filter((sentence) => sentence !== undefined);
  return sentences.length === 0 ? undefined : sentences.join(" ");
};
