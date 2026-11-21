import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";

import {
  DEFAULT_UNIX_DOCKER_HOST,
  DEFAULT_WINDOWS_DOCKER_HOST,
  DOCKER_HOST_PRECEDENCE,
  type DockerContextFileReader,
  dockerContextMetaPath,
  dockerHostSourceLabel,
  normalizeDockerContextHost,
  resolveDockerHostDetails,
} from "../src/docker-context.ts";
import { npipeSocketPath } from "../src/index.ts";

const CONFIG_DIR = "/tmp/lando-docker-config";
const configPath = join(CONFIG_DIR, "config.json");

const files = (entries: Record<string, string | undefined>): DockerContextFileReader => {
  const store = new Map(Object.entries(entries));
  return (path) => store.get(path);
};

const metaJson = (host: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    Endpoints: { docker: { Host: host, ...extra } },
    ...("TLSMaterial" in extra ? { TLSMaterial: extra.TLSMaterial } : {}),
  });

const contextFiles = (
  name: string,
  host: string,
  extra: Record<string, unknown> = {},
  currentContext = name,
): Record<string, string> => ({
  [configPath]: JSON.stringify({ currentContext }),
  [dockerContextMetaPath(CONFIG_DIR, name)]: metaJson(host, extra),
});

const envWithConfig = (env: Record<string, string | undefined> = {}) => ({
  DOCKER_CONFIG: CONFIG_DIR,
  ...env,
});

describe("Docker host precedence", () => {
  test("spells the resolution order in code", () => {
    expect(DOCKER_HOST_PRECEDENCE).toEqual([
      "option",
      "LANDO_TEST_* sockets",
      "DOCKER_HOST",
      "LANDO_DOCKER_DESKTOP",
      "Docker context",
      "platform default",
    ]);
  });

  test("explicit dockerHost wins over test sockets, DOCKER_HOST, Desktop, and context", () => {
    const readFile = files(contextFiles("colima", "unix:///home/alice/.colima/default/docker.sock"));
    const result = resolveDockerHostDetails({
      platform: "linux",
      dockerHost: "tcp://127.0.0.1:2375",
      env: envWithConfig({
        LANDO_TEST_DOCKER_SOCKET: "/tmp/test.sock",
        DOCKER_HOST: "unix:///tmp/docker.sock",
        HOME: "/home/alice",
        LANDO_DOCKER_DESKTOP: "1",
        DOCKER_CONTEXT: "colima",
      }),
      readFile,
    });
    expect(result).toEqual({ ok: true, host: "tcp://127.0.0.1:2375", source: { kind: "option" } });
  });

  test("LANDO_TEST_WINDOWS_DOCKER_SOCKET wins over LANDO_TEST_DOCKER_SOCKET on win32", () => {
    const result = resolveDockerHostDetails({
      platform: "win32",
      env: {
        LANDO_TEST_WINDOWS_DOCKER_SOCKET: "npipe://./pipe/win-test",
        LANDO_TEST_DOCKER_SOCKET: "tcp://generic.example:2375",
        DOCKER_HOST: "tcp://env.example:2375",
      },
      readFile: files({}),
    });
    expect(result).toEqual({
      ok: true,
      host: "npipe://./pipe/win-test",
      source: { kind: "LANDO_TEST_WINDOWS_DOCKER_SOCKET" },
    });
  });

  test("LANDO_TEST_DOCKER_SOCKET wins over DOCKER_HOST, Desktop, and context", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({
        LANDO_TEST_DOCKER_SOCKET: "/tmp/test.sock",
        DOCKER_HOST: "unix:///tmp/docker.sock",
        HOME: "/home/alice",
        LANDO_DOCKER_DESKTOP: "1",
        DOCKER_CONTEXT: "colima",
      }),
      readFile: files(contextFiles("colima", "unix:///home/alice/.colima/default/docker.sock")),
    });
    expect(result).toEqual({
      ok: true,
      host: "/tmp/test.sock",
      source: { kind: "LANDO_TEST_DOCKER_SOCKET" },
    });
  });

  test("DOCKER_HOST wins over LANDO_DOCKER_DESKTOP and context", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({
        DOCKER_HOST: "unix:///tmp/docker.sock",
        HOME: "/home/alice",
        LANDO_DOCKER_DESKTOP: "1",
        DOCKER_CONTEXT: "colima",
      }),
      readFile: files(contextFiles("colima", "unix:///home/alice/.colima/default/docker.sock")),
    });
    expect(result).toEqual({
      ok: true,
      host: "unix:///tmp/docker.sock",
      source: { kind: "DOCKER_HOST" },
    });
  });

  test("LANDO_DOCKER_DESKTOP wins over context on Linux", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({
        HOME: "/home/alice",
        LANDO_DOCKER_DESKTOP: "1",
        DOCKER_CONTEXT: "colima",
      }),
      readFile: files(contextFiles("colima", "unix:///home/alice/.colima/default/docker.sock")),
    });
    expect(result).toEqual({
      ok: true,
      host: "/home/alice/.docker/desktop/docker.sock",
      source: { kind: "LANDO_DOCKER_DESKTOP" },
    });
  });

  test("Docker context wins over the platform default, including win32 npipe", () => {
    const linux = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "colima" }),
      readFile: files(contextFiles("colima", "unix:///home/alice/.colima/default/docker.sock")),
    });
    const windows = resolveDockerHostDetails({
      platform: "win32",
      env: envWithConfig({ DOCKER_CONTEXT: "desktop-linux" }),
      readFile: files(contextFiles("desktop-linux", "npipe:////./pipe/dockerDesktopLinuxEngine")),
    });
    expect(linux).toEqual({
      ok: true,
      host: "unix:///home/alice/.colima/default/docker.sock",
      source: { kind: "context", name: "colima" },
    });
    expect(windows).toEqual({
      ok: true,
      host: "npipe://./pipe/dockerDesktopLinuxEngine",
      source: { kind: "context", name: "desktop-linux" },
    });
  });

  test("platform default is last: unix socket, else win32 npipe", () => {
    expect(resolveDockerHostDetails({ platform: "linux", env: {}, readFile: files({}) })).toEqual({
      ok: true,
      host: DEFAULT_UNIX_DOCKER_HOST,
      source: { kind: "default" },
    });
    expect(resolveDockerHostDetails({ platform: "darwin", env: {}, readFile: files({}) })).toEqual({
      ok: true,
      host: DEFAULT_UNIX_DOCKER_HOST,
      source: { kind: "default" },
    });
    expect(resolveDockerHostDetails({ platform: "win32", env: {}, readFile: files({}) })).toEqual({
      ok: true,
      host: DEFAULT_WINDOWS_DOCKER_HOST,
      source: { kind: "default" },
    });
  });
});

describe("Docker CLI context resolution", () => {
  test("stores context metadata under the lowercase hex SHA-256 of the UTF-8 name", () => {
    expect(dockerContextMetaPath(CONFIG_DIR, "colima")).toBe(
      join(CONFIG_DIR, "contexts", "meta", sha256Hex("colima"), "meta.json"),
    );
    expect(sha256Hex("colima")).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("reads the named context from the SHA-256 metadata directory", () => {
    const path = dockerContextMetaPath(CONFIG_DIR, "colima");
    const readFile: DockerContextFileReader = (candidate) => {
      expect(candidate).toBe(path);
      return metaJson("unix:///home/alice/.colima/default/docker.sock");
    };
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "colima" }),
      readFile,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.host).toBe("unix:///home/alice/.colima/default/docker.sock");
  });

  test("DOCKER_CONTEXT wins over currentContext", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "colima" }),
      readFile: files({
        [configPath]: JSON.stringify({ currentContext: "orbstack" }),
        [dockerContextMetaPath(CONFIG_DIR, "colima")]: metaJson(
          "unix:///home/alice/.colima/default/docker.sock",
        ),
        [dockerContextMetaPath(CONFIG_DIR, "orbstack")]: metaJson(
          "unix:///home/alice/.orbstack/run/docker.sock",
        ),
      }),
    });
    expect(result).toEqual({
      ok: true,
      host: "unix:///home/alice/.colima/default/docker.sock",
      source: { kind: "context", name: "colima" },
    });
  });

  test("uses currentContext from config.json when DOCKER_CONTEXT is unset", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig(),
      readFile: files(contextFiles("orbstack", "unix:///home/alice/.orbstack/run/docker.sock")),
    });
    expect(result).toEqual({
      ok: true,
      host: "unix:///home/alice/.orbstack/run/docker.sock",
      source: { kind: "context", name: "orbstack" },
    });
  });

  test("does not read meta.json when the context name is default", () => {
    const readPaths: string[] = [];
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "default" }),
      readFile: (path) => {
        readPaths.push(path);
        return metaJson("unix:///should-not-use.sock");
      },
    });
    expect(result).toEqual({
      ok: true,
      host: DEFAULT_UNIX_DOCKER_HOST,
      source: { kind: "default" },
    });
    expect(readPaths.some((path) => path.includes("contexts/meta"))).toBe(false);
  });

  test("treats currentContext default as the platform default", () => {
    const result = resolveDockerHostDetails({
      platform: "win32",
      env: envWithConfig(),
      readFile: files({ [configPath]: JSON.stringify({ currentContext: "default" }) }),
    });
    expect(result).toEqual({
      ok: true,
      host: DEFAULT_WINDOWS_DOCKER_HOST,
      source: { kind: "default" },
    });
  });

  test("accepts npipe Host values and normalizes them like the win32 default", () => {
    const host = "npipe:////./pipe/docker_engine";
    expect(normalizeDockerContextHost(host)).toBe(DEFAULT_WINDOWS_DOCKER_HOST);
    expect(npipeSocketPath(normalizeDockerContextHost(host))).toBe(
      npipeSocketPath(DEFAULT_WINDOWS_DOCKER_HOST),
    );
    const result = resolveDockerHostDetails({
      platform: "win32",
      env: envWithConfig({ DOCKER_CONTEXT: "desktop" }),
      readFile: files(contextFiles("desktop", host)),
    });
    expect(result).toEqual({
      ok: true,
      host: DEFAULT_WINDOWS_DOCKER_HOST,
      source: { kind: "context", name: "desktop" },
    });
  });

  test("fails closed on TLSMaterial without falling back to the default socket", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "remote" }),
      readFile: files({
        [dockerContextMetaPath(CONFIG_DIR, "remote")]: JSON.stringify({
          TLSMaterial: { docker: ["ca.pem", "cert.pem", "key.pem"] },
          Endpoints: { docker: { Host: "tcp://remote.example:2376" } },
        }),
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsupported TLS context");
    expect(result.error._tag).toBe("UnsupportedDockerContextError");
    expect(result.error.contextName).toBe("remote");
    expect(result.error.reason).toBe("tls");
    expect(result.error.message).toContain("remote");
  });

  test("fails closed when SkipTLSVerify is set", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "insecure" }),
      readFile: files(contextFiles("insecure", "tcp://127.0.0.1:2376", { SkipTLSVerify: true })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsupported TLS context");
    expect(result.error.reason).toBe("tls");
    expect(result.error.contextName).toBe("insecure");
  });

  test("fails closed on an ssh endpoint without falling back", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "jump" }),
      readFile: files(contextFiles("jump", "ssh://user@host")),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unusable endpoint");
    expect(result.error.reason).toBe("unusable-endpoint");
    expect(result.error.contextName).toBe("jump");
  });

  test("reports missing meta.json for a named context", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "missing" }),
      readFile: files({}),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing meta");
    expect(result.error.reason).toBe("missing-meta");
    expect(result.error.contextName).toBe("missing");
  });

  test("reports invalid meta.json for a named context", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig({ DOCKER_CONTEXT: "broken" }),
      readFile: files({ [dockerContextMetaPath(CONFIG_DIR, "broken")]: "{not-json" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid meta");
    expect(result.error.reason).toBe("invalid-meta");
    expect(result.error.contextName).toBe("broken");
  });

  test("missing config.json with no DOCKER_CONTEXT uses the platform default", () => {
    const result = resolveDockerHostDetails({
      platform: "linux",
      env: envWithConfig(),
      readFile: files({}),
    });
    expect(result).toEqual({
      ok: true,
      host: DEFAULT_UNIX_DOCKER_HOST,
      source: { kind: "default" },
    });
  });

  test("labels doctor sources as DOCKER_HOST, context <name>, LANDO_DOCKER_DESKTOP, or default", () => {
    expect(dockerHostSourceLabel({ kind: "DOCKER_HOST" })).toBe("DOCKER_HOST");
    expect(dockerHostSourceLabel({ kind: "context", name: "colima" })).toBe("context colima");
    expect(dockerHostSourceLabel({ kind: "LANDO_DOCKER_DESKTOP" })).toBe("LANDO_DOCKER_DESKTOP");
    expect(dockerHostSourceLabel({ kind: "default" })).toBe("default");
  });
});
