import { expect, test } from "bun:test";
import { AbsolutePath, AppId, PortablePath } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Schema, Stream } from "effect";
import { type DataPlaneHttpRequest, makeProviderDataPlane, volumeWitnessImage } from "../src/data-plane.ts";
import { echoHelperPull } from "./helper-pull-support.ts";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

test("pins both adoption helpers to the existing container rather than auto-creating a named volume", async () => {
  const calls: DataPlaneHttpRequest[] = [];
  const pulledRefs: string[] = [];
  const ownerRoot = AbsolutePath.make("/canonical/app");
  const witness = { version: 1, ownerRoot, generation: "a1234567-1234-4123-8123-123456789abc" };
  const plane = makeProviderDataPlane({
    providerId: "podman",
    capabilities: { volumeSnapshot: "none" },
    endpointNamespace: "unix:///fixture.sock",
    pullHelperImage: echoHelperPull(pulledRefs),
    redactor: passthroughRedactor,
    api: {
      request: (input) => {
        calls.push(input);
        return Effect.succeed({
          status: 200,
          body: JSON.stringify(
            input.path === "/containers/existing/json"
              ? { Mounts: [{ Type: "volume", Name: "actual", Destination: "/data" }] }
              : input.path === "/volumes/actual"
                ? { Name: "actual", Driver: "local" }
                : { State: { ExitCode: 0 } },
          ),
        });
      },
      stream: () => Stream.make(new TextEncoder().encode(JSON.stringify(witness))),
    },
  });
  const result = await Effect.runPromise(
    plane.adoptVolume({
      app: AppId.make("irrelevant-slug"),
      containerId: "existing",
      destination: PortablePath.make("/data"),
      ownerRoot,
    }),
  );
  const helpers = calls
    .filter((call) => call.path.startsWith("/containers/create"))
    .map((call) =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          Image: Schema.String,
          User: Schema.String,
          Cmd: Schema.Array(Schema.String),
          HostConfig: Schema.Struct({
            VolumesFrom: Schema.Array(Schema.String),
            Binds: Schema.optionalKey(Schema.Array(Schema.String)),
            NetworkMode: Schema.String,
          }),
        }),
      )(call.body),
    );
  expect(helpers).toHaveLength(2);
  expect(helpers.map((helper) => helper.Image)).toEqual([volumeWitnessImage.ref, volumeWitnessImage.ref]);
  expect(calls.some((call) => call.path.startsWith("/images/"))).toBe(false);
  const intents = helpers.map((helper) => {
    expect(helper.User).toBe("0:0");
    expect(helper.HostConfig.Binds).toBeUndefined();
    expect(helper.HostConfig.NetworkMode).toBe("none");
    expect(helper.Cmd.slice(0, 2)).toEqual(["bun", "-e"]);
    return {
      volumesFrom: helper.HostConfig.VolumesFrom,
      ...Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ operation: Schema.String, root: Schema.String })),
      )(helper.Cmd[3]),
    };
  });
  expect(intents).toEqual([
    { volumesFrom: ["existing:rw"], operation: "adopt", root: "/data" },
    { volumesFrom: ["existing:ro"], operation: "read", root: "/data" },
  ]);
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  expect(calls.some((call) => call.path === "/volumes/create")).toBe(false);
  expect(result.identity?.origin).toBe("adopted");
  expect(pulledRefs).toEqual([volumeWitnessImage.ref, volumeWitnessImage.ref]);
});

test("refuses to create a witness helper when the acquired image is not the pinned digest", async () => {
  const calls: DataPlaneHttpRequest[] = [];
  const plane = makeProviderDataPlane({
    providerId: "podman",
    capabilities: { volumeSnapshot: "none" },
    endpointNamespace: "unix:///fixture.sock",
    pullHelperImage: (ref) => Effect.succeed({ ref, digest: `sha256:${"0".repeat(64)}` }),
    redactor: passthroughRedactor,
    api: {
      request: (input) => {
        calls.push(input);
        return Effect.succeed({
          status: 200,
          body: JSON.stringify(
            input.path === "/containers/existing/json"
              ? { Mounts: [{ Type: "volume", Name: "actual", Destination: "/data" }] }
              : { Name: "actual", Driver: "local" },
          ),
        });
      },
      stream: () => Stream.empty,
    },
  });
  const result = await Effect.runPromise(
    plane
      .adoptVolume({
        app: AppId.make("irrelevant-slug"),
        containerId: "existing",
        destination: PortablePath.make("/data"),
        ownerRoot: AbsolutePath.make("/canonical/app"),
      })
      .pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  expect(calls.some((call) => call.path.startsWith("/containers/create"))).toBe(false);
});
