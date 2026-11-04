import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import type { EngineApiClient, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { runNativeInit } from "./support/native-init.ts";

const commandBody = Schema.decodeUnknownSync(Schema.Struct({ Cmd: Schema.Array(Schema.String) }));
const fixtureApi = (failure?: "marker" | "adoption" | "stop" | "descendant" | "pid1") => {
  const calls: EngineHttpRequest[] = [];
  const containers = new Map<string, { readonly name: string; running: boolean }>();
  const exits = new Map<string, number>();
  const request = (input: EngineHttpRequest): Effect.Effect<EngineHttpResponse> =>
    Effect.sync(() => {
      calls.push(input);
      const url = new URL(input.path, "http://fixture");
      const parts = url.pathname.split("/");
      if (url.pathname.includes("/images/")) return { status: 200, body: "{}" };
      if (url.pathname === "/containers/create") {
        const id = `owned-${containers.size}`;
        containers.set(id, { name: url.searchParams.get("name") ?? "", running: false });
        return { status: 201, body: JSON.stringify({ Id: id }) };
      }
      const id = parts[2] ?? "";
      if (parts[1] === "exec")
        return { status: 200, body: JSON.stringify({ Running: false, ExitCode: exits.get(id) ?? 0 }) };
      const container = containers.get(id);
      if (container === undefined) throw new Error(`Unexpected fixture id ${id}`);
      if (input.method === "DELETE") return { status: 204, body: "" };
      if (parts[3] === "start") {
        container.running = true;
        return { status: 204, body: "" };
      }
      if (parts[3] === "stop") {
        if (failure === "stop") return { status: 500, body: "stop failed" };
        container.running = false;
        return { status: 204, body: "" };
      }
      if (parts[3] === "json")
        return {
          status: 200,
          body: JSON.stringify({
            Id: id,
            State: {
              Running: container.running,
              Status: container.running ? "running" : "exited",
              ExitCode: container.name.endsWith("handler-marker") ? 0 : 143,
            },
          }),
        };
      if (parts[3] === "exec") {
        const script = commandBody(input.body).Cmd.at(-1) ?? "";
        const execId = `exec-${exits.size}`;
        exits.set(
          execId,
          (failure === "adoption" && script.includes("kill -TERM")) ||
            (failure === "pid1" && script.includes("cat /proc/1/comm"))
            ? 1
            : 0,
        );
        return { status: 201, body: JSON.stringify({ Id: execId }) };
      }
      if (parts[3] === "logs")
        return {
          status: 200,
          body: container.name.endsWith("handler-marker")
            ? failure === "marker"
              ? ""
              : "native-init-marker\n"
            : container.name.endsWith("nonforwarding-wrapper")
              ? `native-init-wrapper-term\n${failure === "descendant" ? "native-init-descendant-term" : ""}`
              : "",
        };
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
  const api: EngineApiClient = { info: Effect.succeed({}), request };
  return { api, calls };
};
const input = { transport: { kind: "api", provider: "podman", endpoint: "/selected-test.sock" } } as const;

test("native-init driver executes six strict cases and removes every exact acquisition once", async () => {
  // Given
  const fake = fixtureApi();
  // When
  const receipt = await runNativeInit(input, fake.api);
  // Then
  expect(receipt.outcome).toBe("passed");
  expect(receipt.cases).toHaveLength(6);
  expect(fake.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(
    Array.from({ length: 6 }, (_, i) => `/containers/owned-${i}?force=true&v=true` as const),
  );
  const execScripts = fake.calls
    .filter((call) => call.path.endsWith("/exec"))
    .map((call) => commandBody(call.body).Cmd.at(-1));
  expect(execScripts.some((script) => script?.includes("test ! -e /proc/"))).toBe(true);
});

test.each(["marker", "adoption", "stop", "descendant", "pid1"] as const)(
  "native-init driver rejects missing %s evidence and performs bounded owned cleanup",
  async (failure) => {
    // Given
    const fake = fixtureApi(failure);
    // When / Then
    await expect(runNativeInit(input, fake.api)).rejects.toThrow();
    const created = fake.calls.filter((call) => call.path.startsWith("/containers/create")).length;
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(created);
  },
);
