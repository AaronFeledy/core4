import { Arbitrary, Context, Effect, Layer, type Schema } from "effect";

import { LandoEvent } from "../events/union.ts";
import {
  type RendererCapabilities,
  type RendererContribution,
  type RendererIO,
  narrationIO,
} from "../renderer/index.ts";
import { EventService, Renderer } from "../services/index.ts";
import { ContractFailure, requireContract } from "./_shared.ts";

export interface RendererContractHarness {
  readonly contribution: RendererContribution;
  readonly expectedCapabilities: (narrationTTY: boolean) => RendererCapabilities;
}

export const runRendererContract = Effect.fnUntraced(function* (harness: RendererContractHarness) {
  const events = yield* EventService;
  const fixtures: LandoEvent[] = [];
  for (const member of LandoEvent.members) {
    const schema: Schema.Schema<LandoEvent> = member;
    const samples = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
      seed: 1401,
      count: 1,
      size: 1,
    }).pipe(
      Effect.mapError(
        (details) =>
          new ContractFailure({
            message: "Cannot sample built-in renderer event",
            assertion: "every built-in event family is exercised",
            details,
          }),
      ),
    );
    fixtures.push(...samples);
  }
  for (const isTTY of [false, true]) {
    for (const stdoutIsTTY of [false, true]) {
      let stdout = "";
      let stderr = "";
      const io: RendererIO = {
        isTTY,
        stdoutIsTTY,
        terminalColumns: 60,
        terminalRows: 20,
        stdoutColumns: 100,
        writeStdout: (chunk) => {
          stdout += chunk;
        },
        writeStderr: (chunk) => {
          stderr += chunk;
        },
        subscribeInput: () => () => {},
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(harness.contribution.makeService(io));
          const renderer = Context.get(context, Renderer);
          const initial = renderer.capabilities;
          const expected = harness.expectedCapabilities(isTTY);
          yield* requireContract(
            renderer.id === harness.contribution.id,
            "renderer identity matches contribution",
          );
          yield* requireContract(Object.isFrozen(initial), "capability snapshots are immutable");
          yield* requireContract(
            (["color", "interactive", "animation", "notifications"] as const).every(
              (key) => initial[key] === expected[key],
            ),
            "capabilities depend on the narration terminal, not stdout",
            { initial, isTTY, stdoutIsTTY },
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const consumerIO = narrationIO(io);
              yield* requireContract(
                !("writeStdout" in consumerIO) && !("writeStdoutBytes" in consumerIO),
                "event consumers receive narration-only IO without stdout writers",
                { keys: Object.keys(consumerIO) },
              );
              yield* Layer.build(harness.contribution.makeEventConsumer(consumerIO));
              for (const event of fixtures) yield* events.publish(event);
              yield* renderer.message.info("imperative-info");
              yield* renderer.message.warn("imperative-warn");
              yield* renderer.message.error("imperative-error", "remediation");
            }),
          );
          yield* requireContract(stdout === "", "published events and message narration never write stdout", {
            stdout,
          });
          yield* requireContract(stderr.length > 0, "narration reaches stderr");
          const current = renderer.capabilities;
          yield* requireContract(Object.isFrozen(current), "updated capability snapshots remain immutable");
          yield* requireContract(
            (!initial.color || current.color) &&
              (!initial.interactive || current.interactive) &&
              (!initial.animation || current.animation) &&
              (!initial.notifications || current.notifications),
            "capability promotion is monotonic",
          );
          if (["lando", "plain", "json", "verbose"].includes(renderer.id)) {
            yield* requireContract(current === initial, "built-in capability snapshot stays fixed");
          }
          const payload = "alpha\nbeta\npartial";
          yield* renderer.output.stdout("alpha\nbeta\n");
          yield* renderer.output.stdout("partial");
          yield* requireContract(
            stdout === payload,
            "stdout output preserves multiline and partial payload bytes",
            { stdout },
          );
          const before = stderr;
          yield* renderer.output.stderr("diagnostic\npartial");
          yield* requireContract(
            stderr === `${before}diagnostic\npartial`,
            "stderr output is verbatim passthrough",
          );
        }),
      );
    }
  }
});

export const makeRendererContractSuite = runRendererContract;
