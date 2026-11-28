import { expect, test } from "bun:test";
import { dockerEngineIdentity, podmanEngineIdentity } from "../src/engine-identity.ts";

test("Docker engine identity survives a connection alias, not daemon replacement", () => {
  const socket = "unix:///var/run/docker.sock";
  const local = dockerEngineIdentity({ ID: "daemon-a" }, socket);
  const remote = dockerEngineIdentity(
    { ID: "daemon-a" },
    "tcp://user:password@dev:2375/private?token=secret",
  );
  if (local === undefined) throw new Error("Missing local engine identity");
  expect(remote).toEqual({ fingerprint: local.fingerprint, endpoint: "tcp://dev:2375" });
  expect(dockerEngineIdentity({ ID: "daemon-b" }, socket)?.fingerprint).not.toBe(local.fingerprint);
  expect(dockerEngineIdentity({}, socket)).toBeUndefined();
});

test("Podman's changing compatibility ID is never an ownership claim", () => {
  const endpoint = "unix:///podman.sock";
  const compatible = { BuildahVersion: "1.44.0", Name: "dev", DockerRootDir: "/storage" };
  const native = podmanEngineIdentity(
    { host: { hostname: "dev" }, store: { graphRoot: "/storage" } },
    endpoint,
  );
  expect(native).toBeDefined();
  for (const ID of ["first", "second"]) {
    expect(dockerEngineIdentity({ ...compatible, ID }, endpoint)).toEqual(native);
    expect(dockerEngineIdentity({ BuildahVersion: "1.44.0", ID }, endpoint)).toBeUndefined();
  }
  expect(podmanEngineIdentity({ ID: "first" }, endpoint)).toBeUndefined();
});
