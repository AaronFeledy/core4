import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Option, Result } from "effect";

import { makeRuntimeProvider, plugin, resolveDockerHost } from "../src/index.ts";
import { dockerConfig, removeDockerConfigs, tempDir } from "./support/docker-config.ts";

afterEach(removeDockerConfigs);

const COLIMA = "unix:///Users/alice/.colima/default/docker.sock";

const resolved = (options: Parameters<typeof resolveDockerHost>[0]) => {
  const result = resolveDockerHost(options);
  if (Result.isFailure(result)) throw new Error(`expected an endpoint, got ${result.failure.message}`);
  return result.success;
};

const rejected = (options: Parameters<typeof resolveDockerHost>[0]) => {
  const result = resolveDockerHost(options);
  if (Result.isSuccess(result)) throw new Error(`expected a failure, got ${result.success.host}`);
  return result.failure;
};

describe("Docker endpoint precedence", () => {
  test("an explicit host wins over every environment source", () => {
    const config = dockerConfig().context("colima", { Host: COLIMA }).current("colima");
    const env = {
      DOCKER_CONFIG: config.dir,
      LANDO_TEST_WINDOWS_DOCKER_SOCKET: "npipe://./pipe/win-test",
      LANDO_TEST_DOCKER_SOCKET: "/tmp/test.sock",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      DOCKER_CONTEXT: "colima",
    };
    for (const platform of ["linux", "win32"] as const) {
      expect(resolved({ platform, dockerHost: "tcp://127.0.0.1:2375", env })).toEqual({
        host: "tcp://127.0.0.1:2375",
        source: { kind: "option" },
      });
    }
  });

  test("test sockets win over DOCKER_HOST, the Windows one first on win32", () => {
    const env = {
      LANDO_TEST_WINDOWS_DOCKER_SOCKET: "npipe://./pipe/win-test",
      LANDO_TEST_DOCKER_SOCKET: "tcp://generic.example:2375",
      DOCKER_HOST: "tcp://env.example:2375",
    };
    expect(resolved({ platform: "win32", env })).toEqual({
      host: "npipe://./pipe/win-test",
      source: { kind: "LANDO_TEST_WINDOWS_DOCKER_SOCKET" },
    });
    const generic = {
      host: "tcp://generic.example:2375",
      source: { kind: "LANDO_TEST_DOCKER_SOCKET" },
    } as const;
    expect(resolved({ platform: "linux", env })).toEqual(generic);
    const { LANDO_TEST_WINDOWS_DOCKER_SOCKET: _windows, ...withoutWindowsSocket } = env;
    expect(resolved({ platform: "win32", env: withoutWindowsSocket })).toEqual(generic);
  });

  test("DOCKER_HOST wins over DOCKER_CONTEXT and the platform default, as in the Docker CLI", () => {
    const config = dockerConfig().context("colima", { Host: COLIMA });
    const env = {
      DOCKER_CONFIG: config.dir,
      DOCKER_HOST: "tcp://env.example:2375",
      DOCKER_CONTEXT: "colima",
    };
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(resolved({ platform, env })).toEqual({
        host: "tcp://env.example:2375",
        source: { kind: "DOCKER_HOST" },
      });
    }
  });

  test("an empty DOCKER_HOST is unset and the context applies", () => {
    const config = dockerConfig().context("colima", { Host: COLIMA }).current("colima");
    expect(resolved({ platform: "darwin", env: { DOCKER_CONFIG: config.dir, DOCKER_HOST: "" } })).toEqual({
      host: COLIMA,
      source: { kind: "context", name: "colima" },
    });
  });

  test("LANDO_DOCKER_DESKTOP wins over the context on Linux", () => {
    const home = tempDir();
    const config = dockerConfig().context("colima", { Host: COLIMA });
    expect(
      resolved({
        platform: "linux",
        env: { HOME: home, LANDO_DOCKER_DESKTOP: "1", DOCKER_CONFIG: config.dir, DOCKER_CONTEXT: "colima" },
      }),
    ).toEqual({ host: `${home}/.docker/desktop/docker.sock`, source: { kind: "LANDO_DOCKER_DESKTOP" } });
  });

  test("with no override or context, the platform default applies", () => {
    const empty = tempDir();
    for (const platform of ["linux", "wsl", "darwin"] as const) {
      expect(resolved({ platform, env: { DOCKER_CONFIG: empty } })).toEqual({
        host: "/var/run/docker.sock",
        source: { kind: "default" },
      });
    }
    expect(resolved({ platform: "win32", env: { DOCKER_CONFIG: empty } })).toEqual({
      host: "npipe://./pipe/docker_engine",
      source: { kind: "default" },
    });
  });
});

describe("Docker CLI context", () => {
  test("follows currentContext from config.json", () => {
    const config = dockerConfig()
      .context("orbstack", { Host: "unix:///Users/alice/.orbstack/run/docker.sock" })
      .current("orbstack");
    expect(resolved({ platform: "darwin", env: { DOCKER_CONFIG: config.dir } })).toEqual({
      host: "unix:///Users/alice/.orbstack/run/docker.sock",
      source: { kind: "context", name: "orbstack" },
    });
  });

  test("DOCKER_CONTEXT wins over currentContext", () => {
    const config = dockerConfig()
      .context("colima", { Host: COLIMA })
      .context("orbstack", { Host: "unix:///Users/alice/.orbstack/run/docker.sock" })
      .current("orbstack");
    expect(
      resolved({ platform: "darwin", env: { DOCKER_CONFIG: config.dir, DOCKER_CONTEXT: "colima" } }),
    ).toEqual({ host: COLIMA, source: { kind: "context", name: "colima" } });
  });

  test("finds the config under HOME on Unix and USERPROFILE on Windows", () => {
    const home = tempDir();
    dockerConfig(join(home, ".docker")).context("colima", { Host: COLIMA }).current("colima");
    const context = { kind: "context", name: "colima" } as const;
    expect(resolved({ platform: "darwin", env: { HOME: home } }).source).toEqual(context);
    expect(resolved({ platform: "win32", env: { USERPROFILE: home, HOME: tempDir() } }).source).toEqual(
      context,
    );
    expect(resolved({ platform: "win32", env: { HOME: home } }).source).toEqual({ kind: "default" });
  });

  test("the reserved default context means the platform default", () => {
    const config = dockerConfig().current("default");
    expect(resolved({ platform: "win32", env: { DOCKER_CONFIG: config.dir } })).toEqual({
      host: "npipe://./pipe/docker_engine",
      source: { kind: "default" },
    });
    expect(
      resolved({ platform: "linux", env: { DOCKER_CONFIG: config.dir, DOCKER_CONTEXT: "default" } }),
    ).toEqual({ host: "/var/run/docker.sock", source: { kind: "default" } });
  });

  test("an unreadable config.json selects no context, as in the Docker CLI", () => {
    const config = dockerConfig();
    writeFileSync(join(config.dir, "config.json"), "{not json");
    expect(resolved({ platform: "linux", env: { DOCKER_CONFIG: config.dir } }).source).toEqual({
      kind: "default",
    });
  });

  test("Docker Desktop's Windows named pipe uses the same spelling as the default pipe", () => {
    const config = dockerConfig()
      .context("desktop-linux", { Host: "npipe:////./pipe/dockerDesktopLinuxEngine", SkipTLSVerify: false })
      .current("desktop-linux");
    expect(resolved({ platform: "win32", env: { DOCKER_CONFIG: config.dir } })).toEqual({
      host: "npipe://./pipe/dockerDesktopLinuxEngine",
      source: { kind: "context", name: "desktop-linux" },
    });
  });

  test("a plain TCP context resolves to its host", () => {
    const config = dockerConfig().context("tcp", { Host: "tcp://127.0.0.1:2375", SkipTLSVerify: false });
    expect(
      resolved({ platform: "linux", env: { DOCKER_CONFIG: config.dir, DOCKER_CONTEXT: "tcp" } }).host,
    ).toBe("tcp://127.0.0.1:2375");
  });

  test("TLS files are ignored for a socket endpoint, as the Docker CLI ignores them", () => {
    const config = dockerConfig().context("colima", { Host: COLIMA }, ["ca.pem"]).current("colima");
    expect(resolved({ platform: "darwin", env: { DOCKER_CONFIG: config.dir } }).host).toBe(COLIMA);
  });
});

describe("unsupported Docker contexts fail closed", () => {
  test("a TCP context with stored TLS files", () => {
    const config = dockerConfig()
      .context("remote", { Host: "tcp://remote.example:2376", SkipTLSVerify: false }, [
        "ca.pem",
        "cert.pem",
        "key.pem",
      ])
      .current("remote");
    const error = rejected({ platform: "linux", env: { DOCKER_CONFIG: config.dir } });
    expect(error._tag).toBe("UnsupportedDockerContextError");
    expect(error).toMatchObject({ contextName: "remote", reason: "tls" });
    expect(error.message).toContain('"remote"');
    expect(error.remediation).toContain("docker context use");
  });

  test("a TCP context that skips TLS verification still uses TLS", () => {
    const config = dockerConfig().context("insecure", { Host: "tcp://127.0.0.1:2376", SkipTLSVerify: true });
    expect(
      rejected({ platform: "linux", env: { DOCKER_CONFIG: config.dir, DOCKER_CONTEXT: "insecure" } }),
    ).toMatchObject({ contextName: "insecure", reason: "tls" });
  });

  test("an ssh context names its scheme", () => {
    const config = dockerConfig().context("jump", { Host: "ssh://alice@build.example" });
    const error = rejected({ platform: "linux", env: { DOCKER_CONFIG: config.dir, DOCKER_CONTEXT: "jump" } });
    expect(error).toMatchObject({ contextName: "jump", reason: "unsupported-endpoint" });
    expect(error.message).toContain("ssh://");
    expect(error.remediation).toContain("DOCKER_CONTEXT");
  });

  test("a missing, unreadable, or endpoint-less context", () => {
    const config = dockerConfig().rawContext("broken", "{not json").context("empty", {});
    const env = (name: string) => ({ DOCKER_CONFIG: config.dir, DOCKER_CONTEXT: name });
    expect(rejected({ platform: "linux", env: env("missing") }).reason).toBe("not-found");
    expect(rejected({ platform: "linux", env: env("broken") }).reason).toBe("invalid-metadata");
    expect(rejected({ platform: "linux", env: env("empty") }).reason).toBe("no-docker-endpoint");
  });
});

describe("an unsupported context stops the provider before it talks to an engine", () => {
  const tlsContext = () =>
    dockerConfig()
      .context("remote", { Host: "tcp://remote.example:2376" }, ["ca.pem", "cert.pem", "key.pem"])
      .current("remote");

  const expectUnavailable = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) throw new Error("expected a failure");
    const error = Cause.findErrorOption(exit.cause);
    if (Option.isNone(error)) throw new Error(`expected a typed failure, got ${Cause.pretty(exit.cause)}`);
    expect(error.value).toBeInstanceOf(ProviderUnavailableError);
    expect(error.value).toMatchObject({
      providerId: "docker",
      details: { contextName: "remote", reason: "tls" },
    });
  };

  test("provider construction", async () => {
    const config = tlsContext();
    expectUnavailable(
      await Effect.runPromiseExit(
        makeRuntimeProvider({ platform: "linux", env: { DOCKER_CONFIG: config.dir } }),
      ),
    );
  });

  test("data-root purge", async () => {
    const config = tlsContext();
    const purge = plugin.runtimeProviders?.get(ProviderId.make("docker"))?.purge;
    if (purge === undefined) throw new Error("docker provider has no purge hook");
    expectUnavailable(
      await Effect.runPromiseExit(
        purge({
          platform: "linux",
          env: { DOCKER_CONFIG: config.dir },
          dataRoot: tempDir(),
          buildStore: tempDir(),
        }),
      ),
    );
  });
});
