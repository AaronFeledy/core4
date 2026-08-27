import { describe, expect, test } from "bun:test";

import { bindDesktopNotificationTrigger, encodeDesktopNotification } from "../src/notify-trigger.ts";

const ESC = String.fromCharCode(27);

const expectNoCapabilityQuery = (bytes: string): void => {
  expect(bytes.includes("]10;")).toBe(false);
  expect(bytes.includes("]11;")).toBe(false);
  expect(bytes.includes(`${ESC}[6n`)).toBe(false);
  expect(bytes.includes("$p")).toBe(false);
  expect(bytes.includes("p=?")).toBe(false);
};

describe("desktop notification encoding", () => {
  test("does not query terminal capabilities", () => {
    const bytes = encodeDesktopNotification("Completed in 20000ms.", "Lando app:start completed");
    expectNoCapabilityQuery(bytes);
    expect(bytes.includes("]99;")).toBe(true);
    expect(bytes.includes("Lando app:start completed")).toBe(true);
    expect(bytes.includes("Completed in 20000ms.")).toBe(true);
  });

  test("message-only notification still uses OSC 99 without a query", () => {
    const bytes = encodeDesktopNotification("done");
    expectNoCapabilityQuery(bytes);
    expect(bytes.includes("]99;")).toBe(true);
    expect(bytes.includes("done")).toBe(true);
  });
});

describe("desktop notification trigger", () => {
  test("writes encoded OSC without creating a CliRenderer", async () => {
    const writes: string[] = [];
    const trigger = bindDesktopNotificationTrigger((text) => {
      writes.push(text);
    });
    expect(trigger("body", "title")).toBe(true);
    await Promise.resolve();
    const bytes = writes.join("");
    expectNoCapabilityQuery(bytes);
    expect(bytes.includes("]99;")).toBe(true);
    expect(bytes.includes("title")).toBe(true);
    expect(bytes.includes("body")).toBe(true);
  });
});
