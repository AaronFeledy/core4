import { expect, test } from "bun:test";
import { AbsolutePath, AppId, PortablePath } from "@lando/sdk/schema";
import { Effect, Schema, Stream } from "effect";
import { type DataPlaneHttpRequest, makeProviderDataPlane } from "../src/data-plane.ts";

test("pins both adoption helpers to the existing container rather than auto-creating a named volume", async () => {
  const calls: DataPlaneHttpRequest[] = [];
  let imageReady = false;
  let pulls = 0;
  const ownerRoot = AbsolutePath.make("/canonical/app");
  const witness = { version: 1, ownerRoot, generation: "a1234567-1234-4123-8123-123456789abc" };
  const plane = makeProviderDataPlane({
    providerId: "podman",
    snapshotMode: "copy",
    endpointNamespace: "unix:///fixture.sock",
    prepareWitnessImage: Effect.sync(() => {
      imageReady = true;
      pulls++;
    }),
    redactDetails: (value) => value,
    api: {
      request: (input) => {
        calls.push(input);
        if (input.path.startsWith("/images/") && !imageReady)
          return Effect.succeed({ status: 404, body: "{}" });
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
            Binds: Schema.optional(Schema.Array(Schema.String)),
            NetworkMode: Schema.String,
          }),
        }),
      )(call.body),
    );
  expect(helpers).toHaveLength(2);
  const intents = helpers.map((helper) => {
    expect(helper.User).toBe("0:0");
    expect(helper.HostConfig.Binds).toBeUndefined();
    expect(helper.HostConfig.NetworkMode).toBe("none");
    expect(helper.Cmd.slice(0, 2)).toEqual(["bun", "-e"]);
    return {
      volumesFrom: helper.HostConfig.VolumesFrom,
      ...Schema.decodeUnknownSync(
        Schema.parseJson(Schema.Struct({ operation: Schema.String, root: Schema.String })),
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
  expect(pulls).toBe(1);
});
