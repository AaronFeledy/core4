import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { serverLayer, startServer } from "./server";

test.each(["explicit", "ambient"] as const)(
  "resource redaction retains the %s environment captured at service construction",
  async (source) => {
    const key = "MCP_SNAPSHOT_API_TOKEN";
    const secret = "service-construction-private-value";
    const previous = process.env[key];
    const env = { [key]: secret };
    const uri = "lando://doctor";
    try {
      process.env[key] = secret;
      const response = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              serverLayer({
                ...(source === "explicit" ? { sourceEnv: env } : {}),
                resources: [
                  {
                    uri,
                    name: "Doctor",
                    description: "Doctor",
                    resultSchema: Schema.Struct({ value: Schema.String }),
                    read: Effect.succeed({ value: secret }),
                  },
                ],
              }),
            );
            env[key] = "changed-explicit-value";
            process.env[key] = "changed-ambient-value";
            return yield* Effect.gen(function* () {
              const client = yield* startServer();
              return yield* client.request("resources/read", { uri });
            }).pipe(Effect.provide(context));
          }),
        ),
      );
      expect(response).toMatchObject({
        result: { contents: [{ text: JSON.stringify({ value: "[redacted]" }) }] },
      });
      expect(JSON.stringify(response)).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  },
);
