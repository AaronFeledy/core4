import { SSH_AGENT_SOCKET_NAME } from "@lando/sdk/schema";

export const SSH_AGENT_VOLUME = "lando-ssh-agent";
export const SSH_AGENT_DIRECTORY = "/run/lando/ssh-agent";
export const SSH_AGENT_SOCKET = `${SSH_AGENT_DIRECTORY}/${SSH_AGENT_SOCKET_NAME}`;
