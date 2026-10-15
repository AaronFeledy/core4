import { SSH_AGENT_SOCKET_NAME } from "@lando/sdk/schema";

export const SSH_AGENT_VOLUME = "lando-ssh-agent";
export const SSH_AGENT_DIRECTORY = "/run/lando/ssh-agent";
export const SSH_AGENT_SOCKET = `${SSH_AGENT_DIRECTORY}/${SSH_AGENT_SOCKET_NAME}`;

// Private sidecar protocol: POSIX hosts receive the optional bind-mounted endpoint.
export const SSH_AGENT_HOST_DIRECTORY = "/ssh-auth";
export const SSH_AGENT_HOST_SOCKET = `${SSH_AGENT_HOST_DIRECTORY}/ssh-agent.sock`;
