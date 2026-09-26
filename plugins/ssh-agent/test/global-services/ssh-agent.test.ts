import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { ServiceConfig } from "@lando/sdk/schema";

import {
  buildFileLoadSshAgentServiceConfig,
  buildUpstreamSshAgentServiceConfig,
  sshAgentServiceConfigFor,
} from "../../src/global-service.ts";
import sshAgentGlobalService from "../../src/global-service.ts";
import { resolveSshAgentUpstream } from "../../src/upstream.ts";

const decodeConfig = async (): Promise<ServiceConfig> => {
  const previous = {
    upstream: process.env.LANDO_SSH_AGENT_UPSTREAM,
    overlay: process.env.LANDO_CONFIG__ssh_agent__upstream,
  };
  Reflect.deleteProperty(process.env, "LANDO_SSH_AGENT_UPSTREAM");
  Reflect.deleteProperty(process.env, "LANDO_CONFIG__ssh_agent__upstream");
  try {
    const value = await Effect.runPromise(sshAgentGlobalService);
    return Schema.decodeUnknownSync(ServiceConfig)(value);
  } finally {
    if (previous.upstream === undefined) Reflect.deleteProperty(process.env, "LANDO_SSH_AGENT_UPSTREAM");
    else process.env.LANDO_SSH_AGENT_UPSTREAM = previous.upstream;
    if (previous.overlay === undefined)
      Reflect.deleteProperty(process.env, "LANDO_CONFIG__ssh_agent__upstream");
    else process.env.LANDO_CONFIG__ssh_agent__upstream = previous.overlay;
  }
};

const commandText = (config: ServiceConfig): string =>
  typeof config.command === "string" ? config.command : (config.command?.join("\n") ?? "");

const socketMount = {
  type: "bind" as const,
  source: join(makeLandoPaths().roots.userDataRoot, "ssh"),
  target: "/ssh-auth",
  readOnly: false,
};

describe("ssh-agent global service ServiceConfig", () => {
  test("default export is an Effect producing a valid ServiceConfig", async () => {
    const config = await decodeConfig();
    expect(config.api).toBe(4);
    // Compose services apply authored mounts; the socket directory must reach the host.
    expect(config.type).toBe("compose");
    expect(config.appMount).toBe(false);
  });

  test("uses Alpine Linux base image", async () => {
    const config = await decodeConfig();
    expect(config.image).toBe("alpine:3.20");
  });

  test("installs openssh-client and runs real ssh-agent", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    expect(text).toContain("apk add --no-cache openssh-client");
    expect(text).toContain("eval $(ssh-agent -s -a /ssh-auth/ssh-agent.sock)");
    expect(text).toContain("chmod 777 /ssh-auth/ssh-agent.sock");
    expect(text).toContain("ssh-add");
  });

  test("does NOT run as a no-op sleep container", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    expect(text).toContain("ssh-agent");
    expect(text).toContain("openssh-client");
    expect(text).toContain("tail -f /dev/null");
  });

  test("mounts host ssh directory and creates socket directory", async () => {
    const config = await decodeConfig();
    expect(config.mounts).toEqual([
      socketMount,
      {
        type: "bind",
        source: "~/.ssh",
        target: "/root/.ssh",
        readOnly: true,
      },
    ]);
  });

  test("sets SSH_AUTH_SOCK environment variable to the agent socket", async () => {
    const config = await decodeConfig();
    expect(config.environment).toEqual({
      SSH_AUTH_SOCK: "/ssh-auth/ssh-agent.sock",
    });
  });

  test("creates the socket in /ssh-auth directory (bind-mounted from host)", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    expect(text).toContain("mkdir -p /ssh-auth");
    expect(text).toContain("/ssh-auth/ssh-agent.sock");
  });

  test("loads host keys with ssh-add and handles passphrase-protected keys gracefully", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    expect(text).toContain("ssh-add");
    expect(text).toContain("2>/dev/null || true");
  });

  test("factory file-load config matches default ssh-add behavior", () => {
    const config = buildFileLoadSshAgentServiceConfig();
    const text = commandText(config);
    expect(config.type).toBe("compose");
    expect(config.appMount).toBe(false);
    expect(text).toContain("eval $(ssh-agent -s -a /ssh-auth/ssh-agent.sock)");
    expect(text).toContain("ssh-add");
    expect(text).toContain("2>/dev/null || true");
    expect(config.mounts?.some((mount) => typeof mount !== "string" && mount.target === "/root/.ssh")).toBe(
      true,
    );
  });

  test("upstream config relays the host socket and keeps the Lando sidecar socket", () => {
    const config = buildUpstreamSshAgentServiceConfig("/run/user/1000/ssh-agent.sock");
    const text = commandText(config);
    expect(config.type).toBe("compose");
    expect(config.appMount).toBe(false);
    expect(text).toContain("socat UNIX-LISTEN:/ssh-auth/ssh-agent.sock");
    expect(text).toContain("UNIX-CONNECT:/ssh-upstream/agent.sock");
    expect(text).not.toContain("ssh-add");
    expect(config.environment).toEqual({ SSH_AUTH_SOCK: "/ssh-auth/ssh-agent.sock" });
    expect(config.mounts).toEqual([
      socketMount,
      {
        type: "bind",
        source: "/run/user/1000/ssh-agent.sock",
        target: "/ssh-upstream/agent.sock",
        readOnly: false,
      },
    ]);
  });

  test("unsupported and invalid resolutions fail closed instead of baking file-load", () => {
    expect(() =>
      sshAgentServiceConfigFor(
        resolveSshAgentUpstream({
          upstream: "host",
          platform: "win32",
        }),
      ),
    ).toThrow("not supported on Windows");
    expect(() =>
      sshAgentServiceConfigFor(
        resolveSshAgentUpstream({
          upstream: "relative/agent.sock",
          platform: "linux",
        }),
      ),
    ).toThrow("absolute Unix socket path");
  });

  test("missing upstream socket keeps file-load command", () => {
    const config = sshAgentServiceConfigFor(
      resolveSshAgentUpstream({
        upstream: "host",
        platform: "linux",
        isSocket: () => false,
      }),
    );
    const text = commandText(config);
    expect(text).toContain("ssh-add");
    expect(text).not.toContain("socat");
  });
});
