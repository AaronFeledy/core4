import { expect, test } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { locateVolume } from "../src/volume-observation.ts";

test.each([404, 200, 403, 500])(
  "native volume presence is established only by successful inspection: %s",
  async (status) => {
    const provider = {
      providerId: "lando",
      endpointNamespace: "isolated-test",
      api: {
        request: () => Effect.succeed({ status, body: JSON.stringify({ Name: "target", Labels: {} }) }),
      },
    };

    const result = await Effect.runPromise(
      locateVolume(provider, { app: AppId.make("app"), store: "target" }).pipe(Effect.result),
    );

    if (status === 404 || status === 200) {
      expect(result).toMatchObject({
        _tag: "Success",
        success: { presence: status === 404 ? "absent" : "present" },
      });
      if (result._tag === "Success") expect(result.success.identity).toBeUndefined();
    } else {
      expect(result._tag).toBe("Failure");
    }
  },
);
