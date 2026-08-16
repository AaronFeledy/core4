import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import sshAgentGlobalService from "../../src/global-service.ts";

const decodeConfig = async (): Promise<ServiceConfig> => {
  const value = await Effect.runPromise(sshAgentGlobalService);
  return Schema.decodeUnknownSync(ServiceConfig)(value);
};

const commandText = (config: ServiceConfig): string =>
  typeof config.command === "string" ? config.command : (config.command?.join("\n") ?? "");

describe("ssh-agent global service ServiceConfig", () => {
  test("default export is an Effect producing a valid ServiceConfig", async () => {
    const config = await decodeConfig();
    expect(config.api).toBe(4);
    expect(config.type).toBe("lando");
  });

  test("uses Alpine Linux base image", async () => {
    const config = await decodeConfig();
    expect(config.image).toBe("alpine:3.20");
  });

  test("installs openssh-client and runs real ssh-agent", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    // Proves openssh-client is installed (not a no-op alpine sleep container)
    expect(text).toContain("apk add --no-cache openssh-client");
    // Proves ssh-agent is actually started
    expect(text).toContain("eval $(ssh-agent -s -a /ssh-auth/ssh-agent.sock)");
    // Proves socket permissions are set
    expect(text).toContain("chmod 777 /ssh-auth/ssh-agent.sock");
    // Proves host keys are loaded
    expect(text).toContain("ssh-add");
  });

  test("does NOT run as a no-op sleep container", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    // The old stub just ran "tail -f /dev/null" with no ssh-agent
    // Prove we're not that stub by checking for actual ssh-agent work
    expect(text).toContain("ssh-agent");
    expect(text).toContain("openssh-client");
    // The final tail keeps the container alive, but only after ssh-agent is running
    expect(text).toContain("tail -f /dev/null");
  });

  test("mounts host ssh directory and creates socket directory", async () => {
    const config = await decodeConfig();
    expect(config.mounts).toEqual([
      {
        type: "bind",
        source: "${LANDO_USER_DATA_ROOT}/ssh",
        target: "/ssh-auth",
        readOnly: false,
      },
      {
        type: "bind",
        source: "${HOME}/.ssh",
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
    // ssh-add without args loads standard keys (id_rsa, id_dsa, id_ecdsa, id_ed25519)
    expect(text).toContain("ssh-add");
    // Passphrase-protected keys are skipped gracefully (no stdin in container)
    expect(text).toContain("2>/dev/null || true");
  });
});
