import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { RENDERER_CAPABILITIES_TTY, narrationIO } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";
import { Context, Effect, Layer } from "effect";
import { LiveRegionController } from "../src/opentui/live-region-controller.ts";
import { outputJournalFor } from "../src/renderer-output-journal.ts";
import { makeLandoService } from "../src/renderer-service.ts";
import { createTestLiveRegionController, makeLiveRegionFixture } from "./live-region-test-kit.ts";

for (const terminalStdout of [true, false]) {
  test(`journal preserves stdout ownership with terminalStdout=${terminalStdout}`, async () => {
    const calls: string[] = [];
    const terminal = Object.assign(new EventEmitter(), {
      write: (text: string | Uint8Array) => {
        calls.push(`stderr:${text}`);
        return true;
      },
      columns: 80,
      rows: 24,
    });
    const region = new LiveRegionController({ stdout: terminal, width: 80, height: 24 });
    const io = {
      writeStderr: (text: string) => {
        calls.push(`stderr:${text}`);
      },
    };
    const journal = outputJournalFor(io);
    region.setFooter(["tree"]);
    journal.attach(region);
    calls.length = 0;
    journal.writeOutput(
      "alpha\nbeta\n",
      () => {
        calls.push("stdout:alpha\nbeta\n");
      },
      terminalStdout,
    );
    expect(calls).toEqual(
      terminalStdout
        ? ["stderr:\r\u001b[1A\u001b[J", "stdout:alpha\nbeta\n", "stderr:tree\r\n"]
        : ["stdout:alpha\nbeta\n"],
    );
    calls.length = 0;
    journal.writeOutput(
      "partial",
      () => {
        calls.push("stdout:partial");
      },
      terminalStdout,
    );
    expect(calls).toEqual(
      terminalStdout ? ["stderr:\r\u001b[1A\u001b[J", "stdout:partial"] : ["stdout:partial"],
    );
    journal.detach(region);
    await region.dispose();
  });
}

test("stderr byte payload suspends and repaints the attached terminal frame without decoding", async () => {
  // Given
  const calls: (string | Uint8Array)[] = [];
  const terminal = Object.assign(new EventEmitter(), {
    write: (chunk: string | Uint8Array) => {
      calls.push(chunk);
      return true;
    },
    columns: 80,
    rows: 24,
  });
  const io = {
    isTTY: true,
    stdoutIsTTY: false,
    writeStdout: (_chunk: string | Uint8Array) => {},
    writeStderr: (chunk: string | Uint8Array) => {
      calls.push(chunk);
    },
  };
  const region = new LiveRegionController({ stdout: terminal, width: 80, height: 24 });
  const journal = outputJournalFor(io);
  region.setFooter(["tree"]);
  journal.attach(region);
  calls.length = 0;
  const partial = new Uint8Array([0xff, 0xe2, 0x82]);
  const newline = new Uint8Array([10]);
  try {
    // When
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(makeLandoService(io, () => RENDERER_CAPABILITIES_TTY));
          const renderer = Context.get(context, Renderer);
          yield* renderer.output.stderr(partial);
          // Then: no frame can paint in the unfinished payload line.
          expect(calls).toEqual(["\r\u001b[1A\u001b[J", partial]);
          yield* renderer.output.stderr(newline);
        }),
      ),
    );
    // Then
    expect(calls).toEqual(["\r\u001b[1A\u001b[J", partial, "", newline, "tree\r\n"]);
    expect(calls[1]).toBe(partial);
  } finally {
    journal.detach(region);
    await region.dispose();
  }
});

const createSuspendableFullTail = async () => {
  const fixture = makeLiveRegionFixture();
  const controller = await createTestLiveRegionController(fixture);
  fixture.renderer.suspend = () => {
    fixture.calls.push("suspend");
  };
  fixture.renderer.resume = () => {
    fixture.calls.push("resume");
  };
  controller.setFooter(["expanded-tail"]);
  await controller.enterFullTail();
  fixture.writes.length = 0;
  fixture.calls.length = 0;
  const payload = (text: string) =>
    controller.suspendOutput(text, () => {
      fixture.calls.push(`stdout:${text}`);
    });
  return { fixture, controller, payload };
};

test("full-tail stays suspended across a partial payload line and repaints once it completes", async () => {
  // Given
  const { fixture, controller, payload } = await createSuspendableFullTail();

  // When
  payload("part");
  payload("ial");
  const whileOpen = [...fixture.calls];
  payload(" done\n");

  // Then
  expect(whileOpen).toEqual(["suspend", "stdout:part", "stdout:ial"]);
  expect(fixture.calls.slice(whileOpen.length)).toEqual(["stdout: done\n", "resume", "footer:expanded-tail"]);
  expect(fixture.writes).toEqual([]);
  await controller.exitFullTail();
  await controller.dispose();
});

test("full-tail footer and resize updates wait for the open payload line", async () => {
  // Given
  const { fixture, controller, payload } = await createSuspendableFullTail();
  payload("partial");

  // When
  controller.setFooter(["updated-tail"]);
  controller.resize(100, 30);
  const whileOpen = [...fixture.calls];
  payload("\n");

  // Then
  expect(whileOpen).toEqual(["suspend", "stdout:partial", "resize:100x30"]);
  expect(fixture.calls.slice(whileOpen.length)).toEqual(["stdout:\n", "resume", "footer:updated-tail"]);
  await controller.exitFullTail();
  await controller.dispose();
});

test("collapsing full-tail during an open payload line leaves the inline frame erased until the line ends", async () => {
  // Given
  const { fixture, controller, payload } = await createSuspendableFullTail();
  payload("partial");

  // When
  await controller.exitFullTail();
  const afterCollapse = fixture.writes.join("");
  payload(" done\n");

  // Then
  expect(fixture.calls).not.toContain("resume");
  expect(afterCollapse).toBe("");
  expect(fixture.writes.join("")).toBe("expanded-tail\r\n");
  await controller.dispose();
});

test("retiring the tree after a partial payload line leaves a clean frame", async () => {
  // Given
  const { fixture, controller, payload } = await createSuspendableFullTail();
  payload("partial");

  // When
  controller.clearFooter();
  await controller.dispose();

  // Then
  expect(fixture.calls).toEqual(["suspend", "stdout:partial"]);
  expect(fixture.writes).toEqual([]);
});

test("service IO and its consumer narration view share one journal", () => {
  // Given
  const io = { writeStderr: () => {}, writeStdout: () => {} };

  // When
  const consumerIO = narrationIO(io);

  // Then
  expect(outputJournalFor(consumerIO)).toBe(outputJournalFor(io));
});
