import { expect, test } from "bun:test";
import { NetworkTrust } from "@lando/http-client/network-trust";
import type { ResolvedNetworkTrust } from "@lando/sdk/network-trust";
import { ProcessRunner, type ProcessSpawnOptions } from "@lando/sdk/services";
import { makeTestProcessRunner } from "@lando/source-acquisition/testing";
import { Effect } from "effect";
import { retainedSourceTransports } from "../../src/recipes/runtime-sources.ts";
import { baseEngineCompositionInputs } from "../../src/runtime/engine-composition.ts";

test.each(["landofile", "recipe"])("%s composition projects resolved trust into git", async (owner) => {
  const observed: ProcessSpawnOptions[] = [];
  const commit = "a".repeat(40);
  const runner = {
    ...makeTestProcessRunner(),
    run: (input: ProcessSpawnOptions) => {
      observed.push(input);
      return Effect.succeed({ exitCode: 0, stdout: `${commit}\tHEAD`, stderr: "" });
    },
  };
  const trust: ResolvedNetworkTrust = {
    proxy: { https: "http://resolved-proxy.test:3128", noProxy: [] },
    caPems: [],
    trustHost: true,
  };
  const transports =
    owner === "landofile"
      ? baseEngineCompositionInputs.landofileSourcePorts(undefined, undefined, {
          processRunner: runner,
          resolveNetworkTrust: async () => trust,
        }).sources
      : (
          await Effect.runPromise(
            retainedSourceTransports().pipe(
              Effect.provideService(ProcessRunner, runner),
              Effect.provideService(NetworkTrust, trust),
            ),
          )
        ).transports;
  const resolve = transports.git?.resolve;
  if (resolve === undefined) throw new Error("composition must supply git ref resolution");
  expect(await resolve({ url: "https://example.test/repo.git" })).toBe(commit);
  expect(observed).toHaveLength(1);
  expect(observed[0]?.args).toContain("http.proxy=http://resolved-proxy.test:3128");
});
