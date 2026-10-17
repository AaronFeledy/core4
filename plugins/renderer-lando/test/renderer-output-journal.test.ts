import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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

test("full-tail payload suspension never emits inline cursor controls and restores the expanded footer", async () => {
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
  controller.suspendOutput("partial", () => {
    fixture.calls.push("stdout:partial");
  });
  expect(fixture.writes).toEqual([]);
  expect(fixture.calls).toEqual(["suspend", "stdout:partial", "resume", "footer:expanded-tail"]);
  await controller.exitFullTail();
  expect(fixture.writes).toEqual([]);
  await controller.dispose();
});
