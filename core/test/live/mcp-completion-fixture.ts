import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { runFixtureCli } from "./convergence-cli.ts";
import { mcpCliClient } from "./mcp-cli-client.ts";
import { isScannerLiveEligible, managedProviderSocketPath } from "./scanner-live-fixture.ts";

export const mcpAcceptanceBinary = resolve(
  process.env.LANDO_SCENARIO_E2E_BINARY ?? join(import.meta.dir, "../../dist/lando"),
);
export const mcpPrerequisite = !isScannerLiveEligible()
  ? `Set LANDO_TEST_PODMAN_SOCKET to the answering managed socket ${managedProviderSocketPath}, preserving the installation's roots.`
  : Bun.which(mcpAcceptanceBinary) === null
    ? `Build the compiled CLI or set LANDO_SCENARIO_E2E_BINARY; missing ${mcpAcceptanceBinary}.`
    : undefined;

export const mcpCompletionFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-completion-"));
  const name = `mcp-${crypto.randomUUID().slice(0, 12)}`;
  const token = `mcp-acceptance-secret-${crypto.randomUUID()}`;
  const midpoint = Math.floor(token.length / 2);
  const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
  const env = {
    ...inherited,
    LANDO_PROVIDER: "lando",
    LANDO_TELEMETRY_ENABLED: "false",
    MCP_ACCEPTANCE_TOKEN: token,
  };
  const artifactRoot = process.env.LANDO_TEST_ARTIFACT_ROOT;
  let invocation = 0;
  const artifact = async (label: string, value: unknown) => {
    if (artifactRoot !== undefined) {
      await Bun.write(
        join(artifactRoot, `${name}-${++invocation}-${label}.json`),
        JSON.stringify(value).replaceAll(token, "[redacted]"),
      );
    }
  };
  const cli = async (args: readonly string[]) => {
    const result = await Effect.runPromise(runFixtureCli([mcpAcceptanceBinary, ...args], root, env));
    await artifact("cli", { args, ...result });
    expect((result.stdout + result.stderr).includes(token), "CLI disclosed the fixture credential").toBe(
      false,
    );
    return result;
  };
  await Bun.write(
    join(root, ".lando.yml"),
    [
      `name: ${name}`,
      "runtime: 4",
      "provider: lando",
      "router:",
      "  enabled: false",
      "services:",
      "  app:",
      "    type: compose",
      "    image: docker.io/library/alpine:3.21",
      "    home: false",
      "    appMount: false",
      "    workingDirectory: /",
      "    primary: true",
      `    command: [sh, -c, ${JSON.stringify("printf 'quiet-ready\\n'; exec sleep infinity")}]`,
      "    environment:",
      `      MCP_ACCEPTANCE_TOKEN: ${token}`,
      "tooling:",
      "  stream:",
      "    service: app",
      "    cmd:",
      "      - sh",
      "      - -c",
      `      - ${JSON.stringify(`printf 'alpha\\nsplit=${token.slice(0, midpoint)}'; sleep 0.02; printf '${token.slice(midpoint)}\\nutf8=\\342\\202'; sleep 0.02; printf '\\254\\nlast-line'; printf 'stderr-line\\n' >&2`)}`,
      "  fail:",
      "    service: app",
      `    cmd: [sh, -c, ${JSON.stringify("printf 'before-failure'; printf 'failure-diagnostic\\n' >&2; exit 7")}]`,
      "  large:",
      "    service: app",
      `    cmd: [sh, -c, ${JSON.stringify("head -c 300000 /dev/zero | tr '\\000' x; printf 'tail-proof'")}]`,
      "",
    ].join("\n"),
  );
  return {
    name,
    root,
    token,
    cli,
    artifact,
    client: () => mcpCliClient(mcpAcceptanceBinary, root, env),
    async cleanup() {
      const result = await cli(["destroy", "--volumes", "--yes", "--format=json"]);
      expect(result.exitCode, `Failed to remove disposable app ${name}`).toBe(0);
      await rm(root, { recursive: true, force: true });
    },
  };
};
