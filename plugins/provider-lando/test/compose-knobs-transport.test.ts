import { describe, expect, test } from "bun:test";

import { makePodmanApiClient } from "../src/capabilities.ts";
import { isNamedPipeEndpoint } from "../src/named-pipe-api.ts";

// Pure coverage for the endpoint classification that dispatches Podman API
// clients to Windows named-pipe or Unix-socket transports.

describe("provider-lando Podman API transport dispatch", () => {
  test("Given the Windows Lando pipe, when the client is built, then named-pipe transport is selected", () => {
    const endpoint = "npipe:////./pipe/podman-lando";
    const client = makePodmanApiClient(endpoint);

    expect(isNamedPipeEndpoint(endpoint)).toBe(true);
    expect(typeof client.request).toBe("function");
    expect(typeof client.stream).toBe("function");
    expect(client.info).toBeDefined();
    expect(client.ping).toBeDefined();
  });

  test("Given a filesystem socket, when the client is built, then Unix-socket transport is selected", () => {
    const endpoint = "/run/user/1000/podman/podman.sock";
    const client = makePodmanApiClient(endpoint);

    expect(isNamedPipeEndpoint(endpoint)).toBe(false);
    expect(typeof client.request).toBe("function");
    expect(typeof client.stream).toBe("function");
    expect(client.info).toBeDefined();
    expect(client.ping).toBeDefined();
  });
});
