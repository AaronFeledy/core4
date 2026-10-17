import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { narrationIO } from "@lando/sdk/renderer";
import { LiveRegionController } from "../src/opentui/live-region-controller.ts";
import { outputJournalFor } from "../src/renderer-output-journal.ts";
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
