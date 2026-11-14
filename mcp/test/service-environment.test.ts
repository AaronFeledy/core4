import { expect, spyOn, test } from "bun:test";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { Effect, Layer, Schema } from "effect";
import { serverLayer, startServer } from "./server";

test.each(["explicit", "ambient"] as const)(
  "retained resources use captured cwd and %s env after ambient context changes",
  async (source) => {
    const key = "MCP_SNAPSHOT_API_TOKEN";
    const secret = "service-construction-private-value";
    const previous = process.env[key];
    const env = { [key]: secret };
    const uri = "lando://doctor";
    const cwd = process.cwd();
    const cwdSpy = spyOn(process, "cwd");
    try {
      process.env[key] = secret;
      const response = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              serverLayer({
                cwd,
                ...(source === "explicit" ? { env } : {}),
                resources: [
                  {
                    uri,
                    name: "Doctor",
                    description: "Doctor",
                    resultSchema: Schema.Struct({ value: Schema.String, cwd: Schema.String }),
                    read: Effect.map(RuntimeCwd, (cwd) => ({ value: secret, cwd })),
                  },
                ],
              }),
            );
            env[key] = "changed-explicit-value";
            process.env[key] = "changed-ambient-value";
            cwdSpy.mockReturnValue("/changed-ambient-app");
            return yield* Effect.gen(function* () {
              const client = yield* startServer();
              return yield* client.request("resources/read", { uri });
            }).pipe(Effect.provide(context));
          }),
        ),
      );
      expect(response).toMatchObject({
        result: { contents: [{ text: JSON.stringify({ value: "[redacted]", cwd }) }] },
      });
      expect(JSON.stringify(response)).not.toContain(secret);
    } finally {
      cwdSpy.mockRestore();
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  },
);
