import { expect, test } from "bun:test";
import { parseLandofile } from "@lando/sdk/landofile";
import { Effect } from "effect";

test("parses namespaced event keys without consuming the namespace as a value", async () => {
  // Given
  const content =
    "events:\n  pre-ops:migrate:\n    - cmd: echo no\n      service: :host\n  post-docs:generate:\n    - echo done\n";
  // When
  const parsed = await Effect.runPromise(parseLandofile({ file: "/tmp/events.yml", cwd: "/tmp", content }));
  // Then
  expect(parsed).toEqual({
    events: {
      "pre-ops:migrate": [{ cmd: "echo no", service: ":host" }],
      "post-docs:generate": ["echo done"],
    },
  });
});
