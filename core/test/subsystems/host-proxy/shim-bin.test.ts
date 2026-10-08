import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Predicate } from "effect";

import { AGENT_CONTEXT_ENV_ALLOWLIST, AGENT_ENV_ALLOW_EXTRAS_ENV_VAR } from "@lando/engine/config/agent-env";

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

describe("host-proxy shim agent-env allowlist sync", () => {
  test("imports AGENT_CONTEXT_ENV_ALLOWLIST from the engine instead of copying names", async () => {
    const source = await Bun.file(HOST_PROXY_SHIM_SOURCE).text();
    expect(source).toContain('from "@lando/engine/config/agent-env"');
    expect(source).toContain("AGENT_CONTEXT_ENV_ALLOWLIST");
    expect(source).not.toMatch(/"CLAUDECODE"/);
    expect(source).not.toMatch(/"CLINE_ACTIVE"/);
    expect(source).not.toMatch(/"GROK_AGENT"/);
    for (const name of AGENT_CONTEXT_ENV_ALLOWLIST) {
      expect(source.includes(`"${name}"`)).toBe(false);
    }
  });
});

describe("compiled host-proxy shim request serialization", () => {
  test("omits session transport env names while preserving allowed forwarding", async () => {
    const capturedRequest = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("error", reject);
        req.on("end", () => {
          const parsed: unknown = JSON.parse(body);
          if (!Predicate.isObject(parsed)) {
            reject(new Error("Expected shim request body to be an object"));
            return;
          }
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end('{"kind":"exit","code":0}\n');
          resolve(parsed);
        });
      });

      server.on("error", reject);
      server.listen(0, "127.0.0.1", async () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          reject(new Error("Expected TCP test server address"));
          return;
        }

        const proc = Bun.spawn({
          cmd: [await compiledShimArtifact(), "open", "--print"],
          cwd: "/tmp",
          env: {
            LANDO_HOST_PROXY_URL: `http://127.0.0.1:${address.port}`,
            LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
            LANDO_HOST_PROXY_TOKEN: "secret-token",
            LANDO_HOST_PROXY_SESSION: "session-id",
            LANDO_HOST_PROXY_APP: "demo",
            LANDO_HOST_PROXY_DEPTH: "7",
            LANDO_HOST_PROXY_TRANSPORT: "tcp-host-gateway",
            LANDO_HOST_PROXY_SHIM: "/usr/local/bin/lando",
            LANDO_APP_NAME: "demo",
            LC_ALL: "en_US.UTF-8",
            LANG: "en_US.UTF-8",
            TERM: "xterm-256color",
            OPENCODE: "1",
            SECRET_TOKEN: "do-not-forward",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        server.close();
        if (exitCode !== 0) reject(new Error(stderr));
      });
    });

    const request = await capturedRequest;
    expect(request.env).toEqual({
      LANDO_APP_NAME: "demo",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      OPENCODE: "1",
    });
  });

  test("forwards agentEnv.allow extras and GROK_AGENT=1, and drops a GROK_AGENT path", async () => {
    const capturedRequest = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("error", reject);
        req.on("end", () => {
          const parsed: unknown = JSON.parse(body);
          if (!Predicate.isObject(parsed)) {
            reject(new Error("Expected shim request body to be an object"));
            return;
          }
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end('{"kind":"exit","code":0}\n');
          resolve(parsed);
        });
      });

      server.on("error", reject);
      server.listen(0, "127.0.0.1", async () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          reject(new Error("Expected TCP test server address"));
          return;
        }

        const proc = Bun.spawn({
          cmd: [await compiledShimArtifact(), "open", "--print"],
          cwd: "/tmp",
          env: {
            LANDO_HOST_PROXY_URL: `http://127.0.0.1:${address.port}`,
            LANDO_HOST_PROXY_TOKEN: "secret-token",
            LANDO_HOST_PROXY_SESSION: "session-id",
            LANDO_HOST_PROXY_APP: "demo",
            LANDO_HOST_PROXY_DEPTH: "0",
            [AGENT_ENV_ALLOW_EXTRAS_ENV_VAR]: "FOO_TOKEN",
            FOO_TOKEN: "tok",
            GROK_AGENT: "1",
            SECRET_TOKEN: "do-not-forward",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        server.close();
        if (exitCode !== 0) reject(new Error(stderr));
      });
    });

    const request = await capturedRequest;
    expect(request.env).toEqual({
      LANDO_AGENT_ENV_ALLOW: "FOO_TOKEN",
      FOO_TOKEN: "tok",
      GROK_AGENT: "1",
    });
  });
});
