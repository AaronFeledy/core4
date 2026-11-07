import { expect, test } from "bun:test";
import { type AppPlan, PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { withHostProxyRunLando } from "../../src/operations/start-host-proxy.ts";
import { stripHostProxyRunLando } from "../../src/subsystems/host-proxy/transport-feature.ts";
import type { HostProxyRunLandoSession } from "../../src/subsystems/host-proxy/transport.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const session: HostProxyRunLandoSession = {
  appId: "test",
  sessionId: "session",
  token: "token",
  controlToken: "control",
  socketPath: "/host/proxy.sock",
  shimPath: "/host/shim",
  transport: "unix-socket",
  close: () => Promise.resolve(),
  closed: Promise.resolve(),
};
const eligible = {
  ...web,
  extensions: { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } },
};

test("host-proxy mounts are sorted with existing mounts", async () => {
  // Given an eligible service with a deep user mount.
  const input: AppPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...eligible,
        environment: {
          KEEP: "yes",
          LANDO_HOST_PROXY_TOKEN: "old-token",
          LANDO_HOST_PROXY_SESSION: "old-session",
          LANDO_HOST_PROXY_APP: "old-app",
        },
        mounts: [{ type: "tmpfs", target: PortablePath.make("/a/b/c/d/e"), readOnly: false }],
      },
    },
  };
  // When the host-proxy overlay is applied.
  const result = await Effect.runPromise(withHostProxyRunLando(input, session));
  // Then helper mounts precede the deeper user mount.
  expect(result.services[web.name]?.mounts.map((mount) => mount.target)).toEqual([
    PortablePath.make("/run/lando/host-proxy.sock"),
    PortablePath.make("/run/lando/host-proxy/credentials"),
    PortablePath.make("/usr/local/bin/lando"),
    PortablePath.make("/usr/local/bin/open"),
    PortablePath.make("/usr/local/bin/xdg-open"),
    PortablePath.make("/a/b/c/d/e"),
  ]);
  expect(result.services[web.name]?.environment).toEqual({
    KEEP: "yes",
    LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
    LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
    LANDO_HOST_PROXY_DEPTH: "0",
  });
});

test.each(["/usr/local/bin/lando", "/run/lando/host-proxy/credentials"])(
  "host-proxy rejects a collision with a user mount at %s",
  async (target) => {
    // Given a user mount at a helper destination.
    const input: AppPlan = {
      ...plan,
      services: {
        [web.name]: {
          ...eligible,
          mounts: [
            {
              type: "bind",
              origin: "authored",
              source: "/host/tool",
              realization: "passthrough",
              target: PortablePath.make(target),
              readOnly: false,
            },
          ],
        },
      },
    };
    // When the overlay tries to claim the same destination.
    const result = await Effect.runPromise(
      withHostProxyRunLando(stripHostProxyRunLando(input), session).pipe(Effect.result),
    );
    // Then the existing subsystem error reports the collision.
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("HostProxyTransportUnavailableError");
  },
);
