import { expect, test } from "bun:test";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { encodeProgressFrame } from "../src/progress";

test("a progress frame keeps its literal tag when that tag is a registered value", async () => {
  const redactor = createRedactor("secrets", { values: ["stdout"] });
  const frame = await Effect.runPromise(
    encodeProgressFrame({ _tag: "stdout", chunk: "stdout line" }, redactor),
  );
  expect(frame).toEqual({ _tag: "stdout", chunk: "[redacted] line" });
});

test("a progress frame still redacts bound service and source text", async () => {
  const redactor = createRedactor("secrets", { values: ["stdout", "app-name"] });
  const frame = await Effect.runPromise(
    encodeProgressFrame(
      { _tag: "stderr", chunk: "plain", service: "app-name", source: "app-name" },
      redactor,
    ),
  );
  expect(frame).toEqual({
    _tag: "stderr",
    chunk: "plain",
    service: "[redacted]",
    source: "[redacted]",
  });
});
