import { expect, test } from "bun:test";
import { ServiceName, landoNetworkingPlan } from "@lando/sdk/schema";
import { compileServiceProbe } from "../src/service-probe.ts";

const timing = { intervalSeconds: 3, timeoutSeconds: 0.75, retries: 2 };
const executable = "/run/lando/helper/engines/lando-container-helper";
const service = { name: ServiceName.make("web"), endpoints: [] };

test("HTTP probes lower to literal helper argv without service network context", () => {
  expect(compileServiceProbe({ ...timing, kind: "http", url: "https://localhost:9000/ready?a=$b" })).toEqual([
    executable,
    "probe-http",
    "--url",
    "https://localhost:9000/ready?a=$b",
    "--timeout",
    "0.75",
  ]);
});

test.each([true, false])("TCP probes use managed service DNS (private bridge: %s)", (perAppBridge) => {
  const plan = {
    slug: "demo",
    networking: landoNetworkingPlan({
      slug: "demo",
      serviceNames: ["web"],
      sharedCrossAppNetwork: true,
      perAppBridge,
    }),
  };
  const host = perAppBridge ? "web" : "web.demo.internal";
  expect(compileServiceProbe({ ...timing, kind: "tcp", port: 9090 }, plan, service)).toEqual([
    executable,
    "probe-tcp",
    "--host",
    host,
    "--port",
    "9090",
    "--timeout",
    "0.75",
  ]);
  expect(
    compileServiceProbe(
      { ...timing, kind: "tcp", target: { port: 8080, transport: "tcp", names: [], primary: false } },
      plan,
      service,
    ),
  ).toEqual([executable, "probe-tcp", "--host", host, "--port", "8080", "--timeout", "0.75"]);
});
