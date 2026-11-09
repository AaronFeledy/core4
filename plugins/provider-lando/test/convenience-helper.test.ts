import { expect, test } from "bun:test";
import { stubContainerHelper } from "@lando/engine/testing/container-helper";
import { Effect } from "effect";
import { withContainerHelper } from "../src/convenience-helper.ts";

test.each([
  ["amd64", "x64"],
  ["x86_64", "x64"],
  ["aarch64", "arm64"],
  ["arm64", "arm64"],
] as const)("direct calls select the engine's %s helper as %s", async (architecture, arch) => {
  const resolved = await Effect.runPromise(
    withContainerHelper({
      api: {
        request: () => Effect.succeed({ status: 200, body: JSON.stringify({ Architecture: architecture }) }),
      },
    }),
  );

  expect(resolved.helperTarget).toEqual({ os: "linux", arch });
});

test("direct calls preserve explicit helper inputs without probing the engine", async () => {
  const helper = stubContainerHelper("/custom/linux-x64/lando-container-helper");
  const resolved = await Effect.runPromise(
    withContainerHelper({
      api: { request: () => Effect.die("Explicit helper target must not query /info") },
      helperTarget: helper.target,
      resolveContainerHelper: () => Effect.succeed(helper),
    }),
  );

  expect(await Effect.runPromise(resolved.resolveContainerHelper(helper.target))).toEqual(helper);
  expect(resolved.helperTarget).toEqual(helper.target);
});

test("direct calls leave an unsupported engine architecture unavailable", async () => {
  const resolved = await Effect.runPromise(
    withContainerHelper({
      api: {
        request: () => Effect.succeed({ status: 200, body: JSON.stringify({ Architecture: "s390x" }) }),
      },
    }),
  );

  expect(resolved.helperTarget).toBeUndefined();
});
