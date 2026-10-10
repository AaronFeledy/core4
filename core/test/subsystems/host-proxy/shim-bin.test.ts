import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Predicate } from "effect";

import { AGENT_CONTEXT_ENV_ALLOWLIST } from "@lando/engine/config/agent-env";

const HOST_PROXY_SHIM_SOURCE = "core/src/cli/host-proxy/shim-bin.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-host-proxy-shim-bin-"));
  tempDirs.push(dir);
  return dir;
};

const compiledShimArtifact = async (): Promise<string> => {
  const output = join(await tempRoot(), "lando-shim");
  const proc = Bun.spawn({
    cmd: [process.execPath, "build", HOST_PROXY_SHIM_SOURCE, "--compile", "--outfile", output],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
  return output;
};

const captureShimRequest = async (
  artifact: string,
  extraEnv: Readonly<Record<string, string>>,
  responseExitCode = 0,
): Promise<Readonly<Record<string, unknown>>> => {
  const capturedRequest = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("error", capturedRequest.reject);
    req.on("end", () => {
      const parsed: unknown = JSON.parse(body);
      if (!Predicate.isObject(parsed)) {
        capturedRequest.reject(new Error("Expected shim request body to be an object"));
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ kind: "exit", code: responseExitCode })}\n`);
      capturedRequest.resolve(parsed);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Expected TCP test server address");
    }

    const proc = Bun.spawn({
      cmd: [artifact, "open", "--print"],
      cwd: "/tmp",
      env: {
        LANDO_HOST_PROXY_URL: `http://127.0.0.1:${address.port}`,
        LANDO_HOST_PROXY_TOKEN: "secret-token",
        LANDO_HOST_PROXY_SESSION: "session-id",
        LANDO_HOST_PROXY_APP: "demo",
        LANDO_HOST_PROXY_DEPTH: "0",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(10_000),
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0) throw new Error(`Shim exited ${exitCode}: ${stderr}`);
    return await capturedRequest.promise;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("host-proxy shim agent-env allowlist sync", () => {
  test("forwards real values for every engine allowlisted marker", async () => {
    const hostEnv = Object.fromEntries(
      AGENT_CONTEXT_ENV_ALLOWLIST.map((name) => [name, name === "GROK_AGENT" ? "1" : `host-${name}`]),
    );
    const request = await captureShimRequest(await compiledShimArtifact(), hostEnv);
    expect(request.env).toEqual(hostEnv);
  });
});

describe("compiled host-proxy shim request serialization", () => {
  test("rejects a failed shim even after it serializes the request", async () => {
    // Given a compiled shim and a host response that reports failure.
    const artifact = await compiledShimArtifact();

    // When capture waits for the shim to finish, then failure is not a successful capture.
    await expect(captureShimRequest(artifact, {}, 1)).rejects.toThrow();
  });

  test("omits session transport env names while preserving allowed forwarding", async () => {
    const request = await captureShimRequest(await compiledShimArtifact(), {
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
      LANDO_HOST_PROXY_TRANSPORT: "tcp-host-gateway",
      LANDO_HOST_PROXY_SHIM: "/usr/local/bin/lando",
      LANDO_APP_NAME: "demo",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      OPENCODE: "1",
      SECRET_TOKEN: "do-not-forward",
    });
    expect(request.env).toEqual({
      LANDO_APP_NAME: "demo",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      OPENCODE: "1",
    });
  });

  test("forwards GROK_AGENT=1 and drops a path-valued GROK_AGENT", async () => {
    const artifact = await compiledShimArtifact();
    const forwarded = await captureShimRequest(artifact, { GROK_AGENT: "1", FOO_TOKEN: "tok" });
    expect(forwarded.env).toEqual({ GROK_AGENT: "1" });

    const dropped = await captureShimRequest(artifact, { GROK_AGENT: "/home/aaron/.grok/agents/dev" });
    expect(dropped.env).toEqual({});
  });
});
