import { expect, test } from "bun:test";
import { stripAnsi } from "@lando/renderer/console-layout";
import { type ListenerAuthority, PortNumber } from "@lando/sdk/schema";
import { buildInfoSummary, renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import { decorated, result, service } from "./info-storage-fixtures.ts";

const cases: ReadonlyArray<readonly [ListenerAuthority, string]> = [
  [
    {
      owner: "application",
      daemon: "python",
      port: PortNumber.make(8080),
      variables: ["PORT", "FLASK_RUN_PORT"],
    },
    "app-owned · sets `PORT`, `FLASK_RUN_PORT`",
  ],
  [
    { owner: "launcher", daemon: "mongod", port: PortNumber.make(27018), setting: "--port 27018" },
    "your command must pass `--port 27018`",
  ],
  [
    { owner: "image", daemon: "apache", port: PortNumber.make(8080), setting: "Listen 8080" },
    "your image must set `Listen 8080`",
  ],
  [
    {
      owner: "image",
      daemon: "tomcat",
      port: PortNumber.make(8080),
      setting: "Listen 8080",
      file: "server.xml",
    },
    "your image must set `Listen 8080` in server.xml",
  ],
];

test.each(cases)("renders listener authority %j on both human surfaces", (listenerAuthority, text) => {
  // Given planned listener advice, with no provider or observation available.
  const info = result(service("web", undefined, { listenerAuthority }));
  // When rendering the summary and plain output.
  const summary = buildInfoSummary(info);
  const plain = renderInfoAppResult(info);
  const decoratedText = stripAnsi(renderInfoAppResult(info, decorated(200)));
  // Then each surface retains the advice, not a listener health verdict.
  expect(summary.sections[0]?.rows[0]?.fields?.filter((field) => field.label === "listener")).toEqual([
    { label: "listener", value: text },
  ]);
  expect(plain).toContain(`web\tlistener\t${text}`);
  expect(decoratedText).toContain(text);
});

test("omits the listener row when the plan records no authority", () => {
  // Given a service without listener advice.
  const info = result(service("web", undefined));
  // When rendering, then neither human surface invents an owner.
  expect(
    buildInfoSummary(info).sections[0]?.rows[0]?.fields?.filter((field) => field.label === "listener"),
  ).toEqual([]);
  expect(renderInfoAppResult(info)).not.toContain("\tlistener\t");
});

test("escapes control characters in listener settings", () => {
  // Given untrusted image configuration advice.
  const info = result(
    service("web", undefined, {
      listenerAuthority: {
        owner: "image",
        daemon: "web",
        port: PortNumber.make(8080),
        setting: "Listen\n8080",
        file: "server.xml\u001b[31m",
      },
    }),
  );
  // When formatting the listener row, then it cannot inject a row or terminal styling.
  const field = buildInfoSummary(info).sections[0]?.rows[0]?.fields?.find(
    (field) => field.label === "listener",
  );
  expect(field?.value).not.toContain("\n");
  expect(field?.value).not.toContain("\u001b");
});
