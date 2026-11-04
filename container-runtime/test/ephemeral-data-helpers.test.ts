import { describe, expect, test } from "bun:test";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import {
  ephemeralDataHelperLabels,
  listVolumeHolders,
  volumeInUseMessage,
  volumeInUseRemediation,
} from "../src/ephemeral-data-helpers.ts";

const redactor = {
  redactString: (value: string) => value.replaceAll("SENSITIVE", "[REDACTED]"),
  redactValue: (value: unknown) => value,
} satisfies Redactor;

const holder = {
  Id: "exact-id",
  Names: ["/lando-test-data-SENSITIVE"],
  Mounts: [{ Type: "volume", Name: "data" }],
};

describe("data helper diagnostics", () => {
  test("labels helpers without treating the labels as a reclamation lease", () => {
    expect(
      ephemeralDataHelperLabels({ providerId: "test", app: "app", appRoot: "/app", store: "data" }),
    ).toEqual({
      "dev.lando.role": "data-helper",
      "dev.lando.provider": "test",
      "dev.lando.app": "app",
      "dev.lando.app-root": "/app",
      "dev.lando.store": "data",
    });
    expect(ephemeralDataHelperLabels({ providerId: "test" })).toEqual({
      "dev.lando.role": "data-helper",
      "dev.lando.provider": "test",
    });
  });

  test("filters diagnostic holders by exact volume mount even if the daemon ignores filters", async () => {
    const calls: string[] = [];
    const holders = await Effect.runPromise(
      listVolumeHolders((input) => {
        calls.push(`${input.method} ${input.path}`);
        return Effect.succeed({
          status: 200,
          body: JSON.stringify([
            holder,
            { ...holder, Id: "prefix", Mounts: [{ Type: "volume", Name: "data-extra" }] },
            { ...holder, Id: "bind", Mounts: [{ Type: "bind", Name: "data" }] },
            { ...holder, Id: "", Names: [] },
          ]),
        });
      }, "data"),
    );
    expect(holders).toEqual([{ id: "exact-id", name: "lando-test-data-SENSITIVE" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith("GET /containers/json?all=true&filters=");
    expect(
      JSON.parse(new URL(`http://test${calls[0]?.slice(4)}`).searchParams.get("filters") ?? "{}"),
    ).toEqual({ volume: ["data"] });
  });

  test.each([
    { status: 500, body: "SENSITIVE" },
    { status: 200, body: "malformed" },
    { status: 200, body: JSON.stringify([{ Id: "uncertain" }]) },
  ])("retains the original volume failure when listing is unavailable: %j", async (response) => {
    expect(await Effect.runPromise(listVolumeHolders(() => Effect.succeed(response), "data"))).toEqual([]);
  });

  test("does not expose listing failures", async () => {
    expect(await Effect.runPromise(listVolumeHolders(() => Effect.fail("SENSITIVE"), "data"))).toEqual([]);
  });

  test("bounds stalled discovery and closes the request", async () => {
    let closed = false;
    const started = performance.now();
    const holders = await Effect.runPromise(
      listVolumeHolders(
        () =>
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                closed = true;
              }),
            ),
          ),
        "data",
      ),
    );
    expect(holders).toEqual([]);
    expect(closed).toBe(true);
    expect(performance.now() - started).toBeLessThan(2500);
  });

  test.each([JSON.stringify({ message: "SENSITIVE is in use" }), "SENSITIVE is in use"])(
    "redacts names, exact ids and API reasons: %s",
    (body) => {
      const message = volumeInUseMessage(
        "Removal failed.",
        [{ id: "id-SENSITIVE", name: "SENSITIVE" }],
        { body },
        redactor,
      );
      expect(message).toContain("Held by [REDACTED] (id-[REDACTED])");
      expect(message).not.toContain("SENSITIVE");
      expect(volumeInUseRemediation(redactor)).toContain("Wait for any data operation to finish");
    },
  );
});
