import { describe, expect, test } from "bun:test";
import { makeNestedExecute } from "@lando/mcp/execute";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { Cause, Context, Effect, Exit, Schema } from "effect";
import type { McpCommandExecutorShape } from "../src/port";

describe("nested MCP stream drain lifecycle", () => {
  test("captures a flush defect inside the executor Exit after producer scope closes", async () => {
    // Given a scoped producer and an executor that records its actual Exit.
    const order: string[] = [];
    let captured: Exit.Exit<unknown, unknown> | undefined;
    const executor: McpCommandExecutorShape = {
      execute: (command, execution) =>
        Effect.exit(
          command.pipe(
            Effect.map((value) => resolveCommandCompletion(execution.commandId, value, execution.completion)),
          ),
        ).pipe(
          Effect.tap((exit) =>
            Effect.sync(() => {
              captured = exit;
            }),
          ),
        ),
    };
    const defect = new Error("flush defect");
    const execute = makeNestedExecute(
      Context.makeUnsafe<unknown>(new Map()),
      {
        sink: { emit: () => Effect.void },
        finish: () =>
          Effect.sync(() => {
            order.push("flush");
          }).pipe(Effect.andThen(Effect.die(defect))),
      },
      executor,
    );
    // When nested execution completes its command-local producer scope.
    const outcome = await Effect.runPromise(
      execute(
        {
          spec: {
            id: "app:exec",
            summary: "Scoped",
            resultSchema: Schema.Void,
            run: () =>
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  order.push("producer");
                }),
              ),
          },
        },
        { args: {}, flags: {}, argv: [], interaction: "non-interactive" },
      ),
    );
    // Then drain defects share the command Exit rather than escaping transport dispatch.
    expect(order).toEqual(["producer", "flush"]);
    expect(captured !== undefined && Exit.isFailure(captured) && Cause.hasDies(captured.cause)).toBe(true);
    expect(outcome).toEqual({ _tag: "failure", error: defect, additionalErrors: [] });
  });

  test("keeps producer typed failures primary when draining also defects", async () => {
    // Given a typed command failure and a failing final drain.
    const primary = { _tag: "ExecError", message: "execution failed" };
    const secondary = new Error("flush defect");
    const execute = makeNestedExecute(
      Context.makeUnsafe<unknown>(new Map()),
      { sink: { emit: () => Effect.void }, finish: () => Effect.die(secondary) },
      {
        execute: (command, execution) =>
          Effect.exit(
            command.pipe(
              Effect.map((value) =>
                resolveCommandCompletion(execution.commandId, value, execution.completion),
              ),
            ),
          ),
      },
    );
    // When both failures are captured by the executor.
    const outcome = await Effect.runPromise(
      execute(
        {
          spec: {
            id: "app:exec",
            summary: "Fail",
            resultSchema: Schema.Void,
            run: () => Effect.fail(primary),
          },
        },
        { args: {}, flags: {}, argv: [], interaction: "non-interactive" },
      ),
    );
    // Then neither failure is dropped or promoted above the typed primary.
    expect(outcome).toEqual({
      _tag: "failure",
      error: primary,
      additionalErrors: [{ role: "peer", error: secondary }],
    });
  });
});
