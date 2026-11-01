import { expect, test } from "bun:test";
import type { ServiceConnection, StartedService } from "@lando/sdk/schema";
import { renderGlobalServiceRow } from "../../../src/cli/commands/meta/global-common";

test.each([
  { endpoints: [], internal: [], expected: "web (running) no endpoints" },
  {
    endpoints: ["https://a", "https://b"],
    internal: [],
    expected: "web (running) Host: https://a, https://b",
  },
  { endpoints: [], internal: ["tcp://web:1025"], expected: "web (running) App Network: tcp://web:1025" },
  {
    endpoints: ["https://a"],
    internal: ["http://web:8025"],
    expected: "web (running) Host: https://a App Network: http://web:8025",
  },
])("renders host $endpoints and app-network $internal addresses", ({ endpoints, internal, expected }) => {
  const connection = (url: string, scope: "host" | "app"): ServiceConnection => ({
    ...(scope === "host"
      ? ({ scope: "host", source: "publication" } as const)
      : ({ scope: "app", source: "listener" } as const)),
    binding: "assigned",
    state: "active",
    url,
    protocol: "http",
    host: "web",
    port: 80,
    alternateUrls: [],
    endpoint: { port: 80, transport: "tcp", names: [], primary: false },
  });
  const service: StartedService = {
    name: "web",
    state: "running",
    connections: [
      ...endpoints.map((url) => connection(url, "host")),
      ...internal.map((url) => connection(url, "app")),
    ],
  };
  const result = renderGlobalServiceRow(service);
  expect(result).toBe(expected);
});
