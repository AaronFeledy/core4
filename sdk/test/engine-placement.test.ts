import { expect, test } from "bun:test";
import {
  destroyCommand,
  engineEndpointDisplay,
  enginePlacementMismatch,
  matchesEnginePlacement,
} from "@lando/sdk/engine-placement";
import { AbsolutePath, AppId, type EngineIdentity, ProviderId } from "@lando/sdk/schema";

const identity = (fingerprint: string, endpoint: string): EngineIdentity => ({ fingerprint, endpoint });

const record = (provider: string, root: string, engine: EngineIdentity | undefined) => ({
  id: AppId.make("app"),
  provider: ProviderId.make(provider),
  root: AbsolutePath.make(root),
  ...(engine === undefined ? {} : { engineIdentity: engine }),
});

test("an equal fingerprint or an equal canonical endpoint is the same engine", () => {
  expect(
    matchesEnginePlacement(
      identity("same", "unix:///first/podman.sock"),
      identity("same", "unix:///second/podman.sock"),
    ),
  ).toBe(true);
  // The same address is one engine even when its storage identity changed, so it may reconcile.
  expect(
    matchesEnginePlacement(
      identity("first", "unix:///first/podman.sock"),
      identity("second", "unix:///first/podman.sock"),
    ),
  ).toBe(true);
  expect(
    matchesEnginePlacement(
      identity("first", "unix:///first/podman.sock"),
      identity("second", "unix:///second/podman.sock"),
    ),
  ).toBe(false);
});

test("named-pipe spellings of one socket compare equal", () => {
  expect(
    matchesEnginePlacement(
      identity("recorded", "npipe://./pipe/podman-lando"),
      identity("current", "\\\\.\\pipe\\podman-lando"),
    ),
  ).toBe(true);
});

test("a refusal names the redacted endpoints and never the secret prefix", () => {
  const recorded = identity("first", "tcp://user:password@dev:2375/secret-prefix");
  const provider = { id: ProviderId.make("docker"), engineIdentity: identity("second", "unix:///two.sock") };

  const mismatch = enginePlacementMismatch({
    provider,
    kind: "user",
    records: [record("docker", "/apps/one", recorded)],
  });

  expect(mismatch?._tag).toBe("AppPlacementError");
  expect(mismatch?.message).toContain("tcp://dev:2375#prefix=");
  expect(mismatch?.message).not.toContain("secret-prefix");
  expect(mismatch?.message).not.toContain("password");
  expect(mismatch?.message).toContain(engineEndpointDisplay(recorded.endpoint));
});

test("a record that names another engine is refused with both endpoints", () => {
  const first = identity("first", "unix:///first/podman.sock");
  const second = identity("second", "unix:///second/podman.sock");
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
  const provider = { id: ProviderId.make("podman"), engineIdentity: identity("other", "unix:///other.sock") };

  expect(enginePlacementMismatch({ provider, kind: "user", records: [undefined] })).toBeUndefined();
  expect(
    enginePlacementMismatch({
      provider,
      kind: "user",
      records: [record("podman", "/apps", undefined)],
    }),
  ).toBeUndefined();
  expect(
    enginePlacementMismatch({
      provider: { id: ProviderId.make("podman") },
      kind: "user",
      records: [record("podman", "/apps", identity("recorded", "unix:///recorded.sock"))],
    }),
  ).toBeUndefined();
  // Another provider's record belongs to another engine space and is not this provider's to judge.
  expect(
    enginePlacementMismatch({
      provider,
      kind: "user",
      records: [record("docker", "/apps", identity("recorded", "unix:///recorded.sock"))],
    }),
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
