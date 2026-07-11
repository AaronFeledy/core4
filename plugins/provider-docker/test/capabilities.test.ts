import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { Effect, Exit, Stream } from "effect";

import {
  dockerCapabilitiesForHost,
  dockerCapabilitiesForPlatform,
  linuxDockerCapabilities,
  macosDockerCapabilities,
  makeDockerApiClient,
  makeProviderLayer,
  npipeSocketPath,
  resolveDockerHost,
  windowsDockerCapabilities,
} from "@lando/provider-docker";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import { ProviderCapabilities } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

const listen = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const createSelfSignedCertificate = async (
  directory: string,
): Promise<{ readonly key: string; readonly cert: string }> => {
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  const proc = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=127.0.0.1",
      "-days",
      "1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(`openssl failed to create test certificate: ${stderr}`);
  return { key: await Bun.file(keyPath).text(), cert: await Bun.file(certPath).text() };
};

const listenTcp = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected TCP server address"));
        return;
      }
      resolve(address.port);
    });
  });

describe("provider-docker capabilities", () => {
  test("declares every ProviderCapabilities field for Linux and macOS", () => {
    const expectedFields = Object.keys(ProviderCapabilities.fields).sort();
    const linux = dockerCapabilitiesForPlatform("linux");
    const macos = dockerCapabilitiesForPlatform("darwin");

    expect(Object.keys(linux).sort()).toEqual(expectedFields);
    expect(Object.keys(macos).sort()).toEqual(expectedFields);
    expect(linux.bindMountPerformance).toBe("native");
    expect(macos.bindMountPerformance).toBe("slow");
    expect(macos.bindMounts).toBe(true);
    expect(linux.sharedCrossAppNetwork).toBe(true);
    expect(macos.sharedCrossAppNetwork).toBe(true);
  });

  test("classifies Docker host bind mount performance", () => {
    expect(dockerCapabilitiesForHost("linux", "/var/run/docker.sock").bindMountPerformance).toBe("native");
    expect(
      dockerCapabilitiesForHost("linux", "/home/alice/.docker/desktop/docker.sock").bindMountPerformance,
    ).toBe("slow");
    expect(dockerCapabilitiesForHost("linux", "tcp://127.0.0.1:2375").bindMountPerformance).toBe("slow");
    expect(dockerCapabilitiesForHost("darwin", "/var/run/docker.sock").bindMountPerformance).toBe("slow");
  });

  test("introspects platform-specific Docker capabilities after API discovery", async () => {
    const linuxProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "linux", env: {}, dockerApi: { info: Effect.succeed({}) } }),
        ),
      ),
    );
    const macosProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "darwin", env: {}, dockerApi: { info: Effect.succeed({}) } }),
        ),
      ),
    );

    expect(linuxProvider.capabilities).toEqual({ ...linuxDockerCapabilities, serviceLogSources: false });
    expect(macosProvider.capabilities).toEqual({ ...macosDockerCapabilities, serviceLogSources: false });
  });

  test("falls back to static capabilities when default Docker API construction cannot inspect info", async () => {
    const dockerHost = "/tmp/lando-missing-docker.sock";
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "linux", env: { LANDO_TEST_DOCKER_SOCKET: dockerHost } }),
        ),
      ),
    );

    expect(provider.capabilities).toEqual({
      ...dockerCapabilitiesForHost("linux", dockerHost),
      serviceLogSources: false,
    });
  });

  test("does not mask explicitly injected Docker API capability failures", async () => {
    const exit = await Effect.runPromiseExit(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: {},
            dockerApi: {
              info: Effect.fail(
                new ProviderUnavailableError({
                  providerId: "docker",
                  operation: "capabilities",
                  message: "injected failure",
                }),
              ),
            },
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("uses Docker info architecture for host-proxy target capability", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: {},
            dockerApi: { info: Effect.succeed({ Architecture: "aarch64" }) },
          }),
        ),
      ),
    );

    expect(provider.capabilities.providerExtensions).toContain(
      "@lando/core/host-proxy-container-target:linux-arm64",
    );
    expect(provider.capabilities.providerExtensions).not.toContain(
      "@lando/core/host-proxy-container-target:linux-x64",
    );
  });

  test("omits Docker host-proxy target capability when API architecture is missing", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: {},
            dockerApi: { info: Effect.succeed({}) },
          }),
        ),
      ),
    );

    expect(
      provider.capabilities.providerExtensions.some((extension) =>
        extension.startsWith("@lando/core/host-proxy-container-target:"),
      ),
    ).toBe(false);
  });

  test("default construction introspects Docker info architecture through resolved socket transport", async () => {
    const socketDir = await mkdtemp(join(tmpdir(), "lando-provider-docker-default-info-"));
    const socketPath = join(socketDir, "docker.sock");
    const requests: string[] = [];
    const responseBody = JSON.stringify({ Architecture: "x86_64" });
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        requests.push(chunk.toString());
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${responseBody.length}\r\n\r\n${responseBody}`,
        );
      });
    });

    try {
      await listen(server, socketPath);
      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({ platform: "linux", env: { LANDO_TEST_DOCKER_SOCKET: socketPath } }),
          ),
        ),
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]).toStartWith("GET /v1.43/info HTTP/1.1");
      expect(provider.capabilities.providerExtensions).toContain(
        "@lando/core/host-proxy-container-target:linux-x64",
      );
    } finally {
      await close(server);
      await rm(socketDir, { recursive: true, force: true });
    }
  });

  test("advertises Docker Desktop host alias for Windows TCP transport", () => {
    expect(dockerCapabilitiesForHost("win32", "npipe://./pipe/docker_engine").providerExtensions).toContain(
      "@lando/core/host-proxy-transport:tcp-host-gateway:host.docker.internal",
    );
  });

  test("advertises service log source following only when file access is injected", async () => {
    const fs = makeMemoryLogFileAccess();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: {},
            dockerApi: { info: Effect.succeed({}) },
            logFileAccess: fs.access,
          }),
        ),
      ),
    );

    expect(provider.capabilities.serviceLogSources).toBe(true);
  });

  test("uses resolved Docker hosts for API creation and capabilities", async () => {
    const createdHosts: Array<string> = [];
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: {},
            dockerApiFactory: (dockerHost) => {
              createdHosts.push(dockerHost);
              return { info: Effect.succeed({}) };
            },
          }),
        ),
      ),
    );
    const desktopProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: { HOME: "/home/alice", LANDO_DOCKER_DESKTOP: "1" },
            dockerApiFactory: (dockerHost) => {
              createdHosts.push(dockerHost);
              return { info: Effect.succeed({}) };
            },
          }),
        ),
      ),
    );

    expect(createdHosts).toEqual(["/var/run/docker.sock", "/home/alice/.docker/desktop/docker.sock"]);
    expect(provider.capabilities.bindMountPerformance).toBe("native");
    expect(desktopProvider.capabilities.bindMountPerformance).toBe("slow");
  });

  test("supports explicit config and env Docker host discovery", () => {
    expect(resolveDockerHost({ dockerHost: "tcp://127.0.0.1:2375", env: {}, platform: "linux" })).toBe(
      "tcp://127.0.0.1:2375",
    );
    expect(
      resolveDockerHost({ env: { LANDO_TEST_DOCKER_SOCKET: "/tmp/docker.sock" }, platform: "linux" }),
    ).toBe("/tmp/docker.sock");
    expect(resolveDockerHost({ env: { DOCKER_HOST: "unix:///tmp/docker.sock" }, platform: "linux" })).toBe(
      "unix:///tmp/docker.sock",
    );
    expect(
      resolveDockerHost({ env: { HOME: "/home/alice", LANDO_DOCKER_DESKTOP: "1" }, platform: "linux" }),
    ).toBe("/home/alice/.docker/desktop/docker.sock");
    expect(resolveDockerHost({ env: {}, platform: "darwin" })).toBe("/var/run/docker.sock");
  });

  test("declares the Windows capability matrix with slow bind mount performance", () => {
    const expectedFields = Object.keys(ProviderCapabilities.fields).sort();
    const windows = dockerCapabilitiesForPlatform("win32");

    expect(Object.keys(windows).sort()).toEqual(expectedFields);
    expect(windows.bindMountPerformance).toBe("slow");
    expect(windows.bindMounts).toBe(true);
    expect(windows.sharedCrossAppNetwork).toBe(true);
    expect(windows).toEqual(windowsDockerCapabilities);
  });

  test("classifies Windows Docker Desktop bind mount performance", () => {
    expect(dockerCapabilitiesForHost("win32", "npipe://./pipe/docker_engine").bindMountPerformance).toBe(
      "slow",
    );
    expect(dockerCapabilitiesForHost("win32", "tcp://127.0.0.1:2375").bindMountPerformance).toBe("slow");
  });

  test("resolves the Windows Docker Desktop named pipe by default", () => {
    expect(resolveDockerHost({ env: {}, platform: "win32" })).toBe("npipe://./pipe/docker_engine");
  });

  test("Windows discovery honors precedence: explicit > LANDO_TEST_WINDOWS_DOCKER_SOCKET > LANDO_TEST_DOCKER_SOCKET > DOCKER_HOST > default", () => {
    expect(
      resolveDockerHost({
        dockerHost: "tcp://127.0.0.1:2375",
        env: { LANDO_TEST_WINDOWS_DOCKER_SOCKET: "npipe://./pipe/skip" },
        platform: "win32",
      }),
    ).toBe("tcp://127.0.0.1:2375");

    expect(
      resolveDockerHost({
        env: {
          LANDO_TEST_WINDOWS_DOCKER_SOCKET: "tcp://win.example:2375",
          LANDO_TEST_DOCKER_SOCKET: "tcp://generic.example:2375",
          DOCKER_HOST: "tcp://env.example:2375",
        },
        platform: "win32",
      }),
    ).toBe("tcp://win.example:2375");

    expect(
      resolveDockerHost({
        env: {
          LANDO_TEST_DOCKER_SOCKET: "tcp://generic.example:2375",
          DOCKER_HOST: "tcp://env.example:2375",
        },
        platform: "win32",
      }),
    ).toBe("tcp://generic.example:2375");

    expect(resolveDockerHost({ env: { DOCKER_HOST: "tcp://env.example:2375" }, platform: "win32" })).toBe(
      "tcp://env.example:2375",
    );
  });

  test("introspects the Windows Docker capability matrix after API discovery", async () => {
    const windowsProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "win32", env: {}, dockerApi: { info: Effect.succeed({}) } }),
        ),
      ),
    );

    expect(windowsProvider.capabilities).toEqual({ ...windowsDockerCapabilities, serviceLogSources: false });
    expect(windowsProvider.capabilities.bindMountPerformance).toBe("slow");
  });

  test("uses the resolved Windows Docker host when constructing the API client", async () => {
    const createdHosts: Array<string> = [];
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "win32",
            env: {},
            dockerApiFactory: (dockerHost) => {
              createdHosts.push(dockerHost);
              return { info: Effect.succeed({}) };
            },
          }),
        ),
      ),
    );

    expect(createdHosts).toEqual(["npipe://./pipe/docker_engine"]);
    expect(provider.capabilities.bindMountPerformance).toBe("slow");
  });

  test("constructs an npipe Docker API client without invoking the transport", () => {
    const client = makeDockerApiClient("npipe://./pipe/docker_engine");
    expect(typeof client.request).toBe("function");
    expect(typeof client.stream).toBe("function");
  });

  test("normalizes Docker Desktop npipe URIs to Windows named-pipe paths", () => {
    expect(npipeSocketPath("npipe://./pipe/docker_engine")).toBe("\\\\.\\pipe\\docker_engine");
    expect(npipeSocketPath("npipe:////./pipe/docker_engine")).toBe("\\\\.\\pipe\\docker_engine");
  });

  test("sends npipe Docker API requests over an IPC socket", async () => {
    const socketDir = await mkdtemp(join(tmpdir(), "lando-provider-docker-npipe-"));
    const socketPath = join(socketDir, "docker.sock");
    const requests: string[] = [];
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        requests.push(chunk.toString());
        socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
      });
    });

    try {
      await listen(server, socketPath);
      const client = makeDockerApiClient(`npipe:${socketPath}`);
      await Effect.runPromise(client.info);

      expect(requests).toHaveLength(1);
      expect(requests[0]).toStartWith("GET /v1.43/info HTTP/1.1");
    } finally {
      await close(server);
      await rm(socketDir, { recursive: true, force: true });
    }
  });

  test("streams npipe Docker API responses over an IPC socket", async () => {
    const socketDir = await mkdtemp(join(tmpdir(), "lando-provider-docker-npipe-stream-"));
    const socketPath = join(socketDir, "docker.sock");
    const body = new Uint8Array([1, 2, 3]);
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`);
        socket.end(body);
      });
    });

    try {
      await listen(server, socketPath);
      const client = makeDockerApiClient(`npipe:${socketPath}`);
      if (client.stream === undefined) throw new Error("Expected npipe Docker API client to expose stream");
      const chunks = await Effect.runPromise(
        client.stream({ method: "GET", path: "/containers/lando-myapp-web/logs?stdout=true" }).pipe(
          Stream.runCollect,
          Effect.map((collected) => Array.from(collected)),
        ),
      );

      expect(chunks).toEqual([body]);
    } finally {
      await close(server);
      await rm(socketDir, { recursive: true, force: true });
    }
  });
  test("streams attached stdin over HTTPS Docker API sockets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-provider-docker-https-stream-"));
    const { key, cert } = await createSelfSignedCertificate(tempDir);
    const body = new TextEncoder().encode("ok");
    const requests: string[] = [];
    const server = createTlsServer({ key, cert }, (socket) => {
      socket.once("data", (chunk) => {
        requests.push(chunk.toString());
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`);
        socket.end(body);
      });
    });
    const previousDockerTlsVerify = process.env.DOCKER_TLS_VERIFY;

    try {
      process.env.DOCKER_TLS_VERIFY = "0";
      const port = await listenTcp(server);
      const client = makeDockerApiClient(`https://127.0.0.1:${port}`);
      if (client.stream === undefined) throw new Error("Expected HTTPS Docker API client to expose stream");
      const chunks = await Effect.runPromise(
        client
          .stream({
            method: "POST",
            path: "/exec/session/start",
            stdin: (async function* () {
              yield new TextEncoder().encode("typed\n");
            })(),
            body: { Detach: false, Tty: true },
          })
          .pipe(
            Stream.runCollect,
            Effect.map((collected) => Array.from(collected)),
          ),
      );

      expect(requests[0]).toStartWith("POST /v1.43/exec/session/start HTTP/1.1");
      expect(chunks).toEqual([body]);
    } finally {
      if (previousDockerTlsVerify === undefined) {
        process.env.DOCKER_TLS_VERIFY = undefined;
      } else {
        process.env.DOCKER_TLS_VERIFY = previousDockerTlsVerify;
      }
      await close(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("streams delayed npipe chunked responses over an IPC socket", async () => {
    const socketDir = await mkdtemp(join(tmpdir(), "lando-provider-docker-npipe-stream-delayed-"));
    const socketPath = join(socketDir, "docker.sock");
    const encoder = new TextEncoder();
    const first = encoder.encode("hello");
    const second = encoder.encode(" world");
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhe");
        setTimeout(() => socket.write("llo\r\n6\r\n wor"), 10);
        setTimeout(() => socket.end("ld\r\n0\r\n\r\n"), 20);
      });
    });

    try {
      await listen(server, socketPath);
      const client = makeDockerApiClient(`npipe:${socketPath}`);
      if (client.stream === undefined) throw new Error("Expected npipe Docker API client to expose stream");
      const chunks = await Effect.runPromise(
        client.stream({ method: "GET", path: "/containers/lando-myapp-web/logs?stdout=true" }).pipe(
          Stream.runCollect,
          Effect.map((collected) => Array.from(collected)),
        ),
      );

      expect(chunks).toEqual([first, second]);
    } finally {
      await close(server);
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});
