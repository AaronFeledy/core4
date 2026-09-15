import { expect, test } from "bun:test";
import { AbsolutePath, AppId, PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { adoptMountedVolume, observeMountedVolume } from "../src/volume-observation.ts";

const target = {
  app: AppId.make("app"),
  containerId: "existing-id",
  destination: PortablePath.make("/actual/data"),
};
const ownerRoot = AbsolutePath.make("/canonical/owner");
const record = { version: 1, ownerRoot, generation: "a1234567-1234-4123-8123-123456789abc" };
const provider = (driver = "local") => ({
  providerId: "podman",
  endpointNamespace: "unix:///run/user/1000/podman/podman.sock",
  api: {
    request: (input: { readonly path: string }) =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify(
          input.path === "/info"
            ? {}
            : input.path.startsWith("/containers/")
              ? { Mounts: [{ Type: "volume", Name: "actual-native", Destination: target.destination }] }
              : { Name: "actual-native", Driver: driver, Labels: {} },
        ),
      }),
  },
  runWitness: () => Effect.succeed({ exitCode: 0, stdout: JSON.stringify(record), stderr: "" }),
});

test("adopts using the configured endpoint when Podman omits info ID, then re-reads the token", async () => {
  let calls = 0;
  const input = {
    ...provider(),
    runWitness: () => {
      calls++;
      return Effect.succeed({ exitCode: 0, stdout: JSON.stringify(record), stderr: "" });
    },
  };
  const result = await Effect.runPromise(adoptMountedVolume(input, { ...target, ownerRoot }));
  expect(calls).toBe(2);
  expect(result.identity).toEqual({
    nativeName: "actual-native",
    ownerRoot,
    origin: "adopted",
    generation: record.generation,
    coordinationKey: JSON.stringify(["endpoint:unix:///run/user/1000/podman/podman.sock", "actual-native"]),
  });
  expect(result.instanceId).toBeUndefined();
  expect(result.provenance).toBe("legacy");
});

test("observation reads an adopted identity without fabricating creation history", async () => {
  const result = await Effect.runPromise(observeMountedVolume(provider(), target));
  expect(result.identity?.origin).toBe("adopted");
  expect(result.instanceId).toBeUndefined();
});

test("refuses a token changed between publication and re-read", async () => {
  let calls = 0;
  const input = {
    ...provider(),
    runWitness: () =>
      Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          ...record,
          generation: ++calls === 1 ? record.generation : "b1234567-1234-4123-8123-123456789abc",
        }),
      }),
  };
  expect(
    (await Effect.runPromise(Effect.either(adoptMountedVolume(input, { ...target, ownerRoot }))))._tag,
  ).toBe("Left");
});

test("refuses foreign ownership returned by a helper", async () => {
  expect(
    (
      await Effect.runPromise(
        Effect.either(
          adoptMountedVolume(provider(), { ...target, ownerRoot: AbsolutePath.make("/foreign") }),
        ),
      )
    )._tag,
  ).toBe("Left");
});

test("rejects unsupported drivers before starting a witness helper", async () => {
  let called = false;
  const input = {
    ...provider("nfs"),
    runWitness: () => {
      called = true;
      return Effect.succeed({ exitCode: 0, stdout: JSON.stringify(record), stderr: "" });
    },
  };
  expect(
    (await Effect.runPromise(Effect.either(adoptMountedVolume(input, { ...target, ownerRoot }))))._tag,
  ).toBe("Left");
  expect(called).toBe(false);
});
