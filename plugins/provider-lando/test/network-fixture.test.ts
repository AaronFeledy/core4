import { expect, test } from "bun:test";
import { decodeNetworkCreate } from "./network-fixture.ts";

const labels = { "dev.lando.app": "scratch", "dev.lando.scratch-id": "different", extra: "kept" };

test("decodes submitted Docker and native network identity without rewriting labels", () => {
  expect(
    decodeNetworkCreate({
      method: "POST",
      path: "/networks/create",
      body: {
        Name: "private",
        Driver: "macvlan",
        Labels: labels,
      },
    }),
  ).toEqual({ Name: "private", Driver: "macvlan", Labels: labels });
  expect(
    decodeNetworkCreate({
      method: "POST",
      path: "/libpod/networks/create",
      body: {
        name: "private",
        driver: "bridge",
        dns_enabled: true,
        options: { metric: "50" },
        labels,
      },
    }),
  ).toEqual({ Name: "private", Driver: "bridge", Labels: labels });
  expect(
    decodeNetworkCreate({
      method: "POST",
      path: "/networks/create",
      body: {
        Name: "shared",
        Driver: "bridge",
      },
    }),
  ).toEqual({ Name: "shared", Driver: "bridge" });
});

test("ignores non-create requests and rejects missing driver or invalid native options", () => {
  expect(decodeNetworkCreate({ method: "GET", path: "/networks/create" })).toBeUndefined();
  expect(decodeNetworkCreate({ method: "POST", path: "/networks/private" })).toBeUndefined();
  expect(() =>
    decodeNetworkCreate({
      method: "POST",
      path: "/networks/create",
      body: {
        Name: "private",
        Labels: labels,
      },
    }),
  ).toThrow();
  expect(() =>
    decodeNetworkCreate({
      method: "POST",
      path: "/networks/create",
      body: {
        Name: "private",
        Driver: 12,
      },
    }),
  ).toThrow();
  expect(() =>
    decodeNetworkCreate({
      method: "POST",
      path: "/libpod/networks/create",
      body: {
        name: "private",
        driver: "bridge",
        dns_enabled: false,
        options: { metric: "50" },
        labels,
      },
    }),
  ).toThrow();
  expect(() =>
    decodeNetworkCreate({
      method: "POST",
      path: "/libpod/networks/create",
      body: {
        name: "private",
        driver: "bridge",
        dns_enabled: true,
        options: { metric: "90" },
        labels,
      },
    }),
  ).toThrow();
});
