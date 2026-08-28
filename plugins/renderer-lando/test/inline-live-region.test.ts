import { describe, expect, test } from "bun:test";

import { createInlineLiveRegionPainter } from "../src/opentui/inline-live-region.ts";

const ESC = String.fromCharCode(27);
const CSI_AJ = new RegExp(`${ESC}\\[[0-9;]*[AJ]`);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

const capturePainter = () => {
  const writes: string[] = [];
  const painter = createInlineLiveRegionPainter((text) => {
    writes.push(text);
  });
  return { painter, writes };
};

const writtenText = (writes: ReadonlyArray<string>): string => writes.join("");

const expectStrippedPayload = (text: string): void => {
  expect(text).toContain("safe");
  expect(text).not.toContain(String.fromCharCode(7));
  expect(text).not.toContain("U0VDUkVU");
  expect(text).not.toContain("spoofed title");
  expect(text).not.toContain("example.invalid");
  expect(text.replace(SGR, "")).not.toContain(ESC);
};

const dirtyPayload = (): string => {
  const bell = String.fromCharCode(7);
  return [
    "safe",
    `${ESC}]52;c;U0VDUkVU${bell}`,
    `${ESC}]0;spoofed title${ESC}\\`,
    `${ESC}]8;;https://example.invalid${ESC}\\link${ESC}]8;;${ESC}\\`,
    `${ESC}[2J${ESC}[10A`,
    "tail",
  ].join("");
};

describe("createInlineLiveRegionPainter", () => {
  test("writes the first paint as joined lines without CSI A or J", () => {
    // given
    const { painter, writes } = capturePainter();

    // when
    painter.paint(["a", "b"]);

    // then
    const written = writtenText(writes);
    expect(written).toBe("a\nb\n");
    expect(written).not.toMatch(CSI_AJ);
  });

  test("rewinds previous rows then paints when the region grows", () => {
    // given
    const { painter, writes } = capturePainter();
    painter.paint(["a", "b"]);
    writes.length = 0;

    // when
    painter.paint(["a", "b", "c"]);

    // then
    expect(writtenText(writes)).toBe(`${ESC}[2A${ESC}[Ja\nb\nc\n`);
  });

  test("rewinds the previous painted row count when the region shrinks", () => {
    // given
    const { painter, writes } = capturePainter();
    painter.paint(["a", "b"]);
    painter.paint(["a", "b", "c"]);
    writes.length = 0;

    // when
    painter.paint(["a"]);

    // then
    expect(writtenText(writes)).toBe(`${ESC}[3A${ESC}[Ja\n`);
  });

  test("does not append a newline to carriage-return progress", () => {
    // given
    const { painter, writes } = capturePainter();

    // when
    painter.commitAbove("  53/108 [=====>----]  49%\r");

    // then
    expect(writtenText(writes)).toBe("  53/108 [=====>----]  49%\r");
    expect(writtenText(writes).endsWith("\n")).toBe(false);
  });

  test("does not append a newline to Composer CSI cursor progress", () => {
    // given
    const { painter, writes } = capturePainter();
    const bar = `${ESC}[1G${ESC}[2K  53/108 [=====>----]  49%`;

    // when
    painter.commitAbove(bar);

    // then
    expect(writtenText(writes)).toBe(bar);
    expect(writtenText(writes).endsWith("\n")).toBe(false);
  });

  test("does not append a newline to the first unterminated Composer progress frame", () => {
    // given
    const { painter, writes } = capturePainter();
    const first = "  0/108 [>---------------------------]   0%";
    const next = `${ESC}[1G${ESC}[2K  53/108 [=============>--------------]  49%`;

    // when
    painter.commitAbove(first);
    painter.commitAbove(next);

    // then
    expect(writtenText(writes)).toBe(`${first}${next}`);
    expect(writtenText(writes).endsWith("\n")).toBe(false);
  });

  test("commits above by clearing the region and treats the next paint as first", () => {
    // given
    const { painter, writes } = capturePainter();
    painter.paint(["a", "b"]);
    writes.length = 0;

    // when
    painter.commitAbove("log");

    // then
    expect(writtenText(writes)).toBe(`${ESC}[2A${ESC}[Jlog`);

    writes.length = 0;
    painter.paint(["x"]);
    const written = writtenText(writes);
    expect(written).toBe("x\n");
    expect(written).not.toMatch(CSI_AJ);
  });

  test("paints an empty frame by erasing previous rows", () => {
    // given
    const { painter, writes } = capturePainter();
    painter.paint(["status"]);
    writes.length = 0;

    // when
    painter.paint([]);

    // then
    expect(writtenText(writes)).toBe(`${ESC}[1A${ESC}[J`);
  });

  test("release writes nothing and treats the next paint as first", () => {
    // given
    const { painter, writes } = capturePainter();
    painter.paint(["a", "b"]);
    writes.length = 0;

    // when
    painter.release();

    // then
    expect(writes).toEqual([]);

    painter.paint(["z"]);
    const written = writtenText(writes);
    expect(written).toBe("z\n");
    expect(written).not.toMatch(CSI_AJ);
  });

  test("strips non-SGR controls from paint and commitAbove text", () => {
    // given
    const payload = dirtyPayload();
    const paintCapture = capturePainter();
    const commitCapture = capturePainter();

    // when
    paintCapture.painter.paint([payload]);
    commitCapture.painter.commitAbove(payload);

    // then
    expectStrippedPayload(writtenText(paintCapture.writes));
    expectStrippedPayload(writtenText(commitCapture.writes));
  });
});
