import { Schema } from "effect";
import { AbsolutePath, AppId, PortNumber } from "./primitives.ts";

export const AGENT_SOCKET_CONTAINER_DIR = {
  ssh: "/run/lando/ssh-agent",
  gpg: "/run/lando/gpg-agent",
} as const;
export const SSH_AGENT_SOCKET_NAME = "agent.sock";
export const GPG_AGENT_SOCKET_NAME = "S.gpg-agent";

// ====
// Agent forwarding configuration.

export const SshAgentConfig = Schema.Struct({
  sidecar: Schema.optional(Schema.Boolean).annotations({
    description: "Use the managed SSH agent when true (the default), or forward the host agent when false.",
  }),
  socket: Schema.optional(Schema.String).annotations({
    description: "Explicit host SSH-agent socket path used instead of automatic discovery in host mode.",
  }),
});
export type SshAgentConfig = typeof SshAgentConfig.Type;

export const GpgAgentConfig = Schema.Struct({
  forward: Schema.optional(Schema.Boolean).annotations({
    description: "Forward the host GPG agent for signing when true; disabled by default.",
  }),
  socket: Schema.optional(Schema.String).annotations({
    description: "Explicit host GPG-agent extra socket path used instead of automatic discovery.",
  }),
});
export type GpgAgentConfig = typeof GpgAgentConfig.Type;

export const AgentSocketKind = Schema.Literal("ssh", "gpg");
export type AgentSocketKind = typeof AgentSocketKind.Type;

export const AgentSocketDelivery = Schema.Literal("bind-directory", "guest-bridge", "volume-relay");
export type AgentSocketDelivery = typeof AgentSocketDelivery.Type;

export const AgentSocketProviderCapabilities = Schema.Struct({
  delivery: AgentSocketDelivery.annotations({
    description: "Supported mechanism for delivering an agent socket to app service containers.",
  }),
});
export type AgentSocketProviderCapabilities = typeof AgentSocketProviderCapabilities.Type;

export const AgentSocketUpstream = Schema.Union(
  Schema.TaggedStruct("unix", {
    _tag: Schema.tag("unix").annotations({ description: "Unix socket upstream discriminator." }),
    path: Schema.String.annotations({ description: "Host Unix socket path carrying the agent byte stream." }),
  }),
  Schema.TaggedStruct("loopback-tcp", {
    _tag: Schema.tag("loopback-tcp").annotations({ description: "Loopback TCP upstream discriminator." }),
    port: PortNumber.annotations({ description: "Host loopback TCP port carrying the agent byte stream." }),
    token: Schema.optional(Schema.String).annotations({
      description: "Authentication token required by the loopback broker before relaying agent bytes.",
    }),
  }),
);
export type AgentSocketUpstream = typeof AgentSocketUpstream.Type;

export const AgentSocketBridgeInput = Schema.Struct({
  appId: AppId.annotations({ description: "App identity owning this agent socket bridge." }),
  appRoot: AbsolutePath.annotations({
    description: "Canonical app root used to derive ownership of provider bridge resources.",
  }),
  sessionId: Schema.String.annotations({
    description: "Unique relay session identity used to isolate bridge resources.",
  }),
  kind: AgentSocketKind.annotations({ description: "Agent protocol carried by this bridge." }),
  upstream: AgentSocketUpstream.annotations({
    description: "Host relay endpoint to forward into the provider.",
  }),
  socketName: Schema.String.annotations({
    description: "Socket filename to create inside the delivered directory or volume.",
  }),
});
export type AgentSocketBridgeInput = typeof AgentSocketBridgeInput.Type;

export const AgentSocketBridgeResult = Schema.Union(
  Schema.TaggedStruct("bind-directory", {
    _tag: Schema.tag("bind-directory").annotations({
      description: "Directory-backed agent socket delivery discriminator.",
    }),
    directory: AbsolutePath.annotations({
      description: "Provider-visible directory containing the named agent socket, mounted into app services.",
    }),
  }),
  Schema.TaggedStruct("volume", {
    _tag: Schema.tag("volume").annotations({
      description: "Volume-backed agent socket delivery discriminator.",
    }),
    volume: Schema.String.annotations({
      description: "Provider-owned volume containing the named agent socket, mounted into app services.",
    }),
  }),
);
export type AgentSocketBridgeResult = typeof AgentSocketBridgeResult.Type;
