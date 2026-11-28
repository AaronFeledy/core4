import { expect, test } from "bun:test";
import { AbsolutePath, AppId, type EngineIdentity, ProviderId } from "@lando/sdk/schema";
import {
  destroyCommand,
  dockerEngineIdentity,
  enginePlacementMismatch,
  matchesEnginePlacement,
  podmanEngineIdentity,
} from "../src/engine-identity.ts";

test("Docker engine identity survives a connection alias, not daemon replacement", () => {
  const socket = "unix:///var/run/docker.sock";
  const local = dockerEngineIdentity({ ID: "daemon-a" }, socket);
  const remote = dockerEngineIdentity(
    { ID: "daemon-a" },
    "tcp://user:password@dev:2375/private?token=secret",
  );
  if (local === undefined || remote === undefined) throw new Error("Missing engine identity");
  expect(remote.fingerprint).toBe(local.fingerprint);
  expect(remote.endpoint).toContain("tcp://dev:2375");
  for (const privatePart of ["user", "password", "private", "token", "secret"])
    expect(remote.endpoint).not.toContain(privatePart);
  const replacement = dockerEngineIdentity({ ID: "daemon-b" }, "http://dev:2375/private/");
  const other = dockerEngineIdentity({ ID: "daemon-b" }, "tcp://dev:2375/other");
  if (!replacement || !other) throw new Error("Missing remote engine identity");
  expect(matchesEnginePlacement(remote, replacement)).toBe(true);
  expect(matchesEnginePlacement(remote, other)).toBe(false);
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

const record = (provider: string, root: string, identity: EngineIdentity | undefined) => ({
  id: AppId.make("app"),
  provider: ProviderId.make(provider),
  root: AbsolutePath.make(root),
  ...(identity === undefined ? {} : { engineIdentity: identity }),
});

test("a record that names another engine is refused with both endpoints", () => {
  const first = podmanEngineIdentity(
    { host: { hostname: "first" }, store: { graphRoot: "/storage" } },
    "unix:///first/podman.sock",
  );
  const second = podmanEngineIdentity(
    { host: { hostname: "second" }, store: { graphRoot: "/storage" } },
    "unix:///second/podman.sock",
  );
  if (first === undefined || second === undefined) throw new Error("Missing engine identity");
  const provider = { id: ProviderId.make("podman"), engineIdentity: second };

  const mismatch = enginePlacementMismatch({
    provider,
    kind: "user",
    records: [record("podman", "/apps/one", first)],
  });

  expect(mismatch?._tag).toBe("AppPlacementError");
  expect(mismatch?.message).toContain("unix:///first/podman.sock");
  expect(mismatch?.message).toContain("unix:///second/podman.sock");
  expect(mismatch?.remediation).toContain("lando destroy --provider=podman --yes");
  expect(mismatch?.remediation).toContain("DOCKER_HOST");
});

test("records without identity and providers without one are never judged", () => {
  const identity = podmanEngineIdentity(
    { host: { hostname: "first" }, store: { graphRoot: "/storage" } },
    "unix:///podman.sock",
  );
  if (identity === undefined) throw new Error("Missing engine identity");
  const other = podmanEngineIdentity(
    { host: { hostname: "second" }, store: { graphRoot: "/storage" } },
    "unix:///podman.sock",
  );
  if (other === undefined) throw new Error("Missing engine identity");
  const provider = { id: ProviderId.make("podman"), engineIdentity: other };

  expect(enginePlacementMismatch({ provider, kind: "user", records: [undefined] })).toBeUndefined();
  expect(
    enginePlacementMismatch({ provider, kind: "user", records: [record("podman", "/apps", undefined)] }),
  ).toBeUndefined();
  expect(
    enginePlacementMismatch({
      provider: { id: ProviderId.make("podman") },
      kind: "user",
      records: [record("podman", "/apps", identity)],
    }),
  ).toBeUndefined();
  // Another provider's record belongs to another engine space and is not this provider's to judge.
  expect(
    enginePlacementMismatch({ provider, kind: "user", records: [record("docker", "/apps", identity)] }),
  ).toBeUndefined();
});

test("a refusal names the command that retires each app kind", () => {
  expect(destroyCommand({ kind: "user", id: AppId.make("web") }, ProviderId.make("podman"))).toBe(
    "lando destroy --provider=podman --yes",
  );
  expect(destroyCommand({ kind: "global", id: AppId.make("global") }, ProviderId.make("podman"))).toBe(
    "lando global:destroy --provider=podman --yes",
  );
  expect(destroyCommand({ kind: "scratch", id: AppId.make("quick") }, ProviderId.make("podman"))).toBe(
    "lando scratch:destroy quick --keep-volumes --yes",
  );
});
