import { DateTime, Effect } from "effect";

import { bringDown, bringUp, exec, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import {
  MAILPIT_IMAGE,
  MAILPIT_SHARED_NETWORK_HOST,
  MAILPIT_SMTP_PORT,
  MAILPIT_WEB_PORT,
} from "../../../plugins/service-lando/src/mailpit-constants.ts";

const providerId = ProviderId.make("lando");
const SUBJECT = "Mailpit live integration";
const RECIPIENT = "recipient@example.lndo.site";
// Minimal base image with a busybox shell + `nc`, used to drive SMTP from inside
// a per-app service container.
const SENDER_IMAGE = "alpine:3.21";

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-30T00:00:00Z"),
  source: "global-mailpit-live.integration.test",
  runtime: 4 as const,
};

const appPlan = (slug: string, service: ServicePlan): AppPlan => ({
  id: AppId.make(slug),
  name: slug,
  slug,
  root: AbsolutePath.make(`/tmp/lando-${slug}`),
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
});

const mailpitService = (): ServicePlan => ({
  name: ServiceName.make("mailpit"),
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: MAILPIT_IMAGE },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    { port: MAILPIT_SMTP_PORT, protocol: "tcp", name: "smtp" },
    { port: MAILPIT_WEB_PORT, protocol: "http", name: "web" },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

// A per-app service that stays alive so the test can exec an SMTP send from
// inside its container, exercising the shared cross-app network DNS alias the
// per-app `LANDO_MAIL_HOST` env var points at.
const senderService = (): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: SENDER_IMAGE },
  command: ["sleep", "infinity"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

// Raw SMTP conversation piped to the global Mailpit service over the shared
// cross-app network. Mailpit advertises PIPELINING, so the buffered commands are
// processed in order even after the client half-closes the connection.
const smtpPayload = [
  "HELO web.shop.internal",
  "MAIL FROM:<sender@example.lndo.site>",
  `RCPT TO:<${RECIPIENT}>`,
  "DATA",
  `Subject: ${SUBJECT}`,
  `To: ${RECIPIENT}`,
  "From: sender@example.lndo.site",
  "",
  "Mailpit works from a per-app service.",
  ".",
  "QUIT",
  "",
].join("\\r\\n");

const sendMailFromService = async (
  plan: AppPlan,
  api: ReturnType<typeof makePodmanApiClient>,
): Promise<void> => {
  const target = { app: AppId.make(plan.slug), service: ServiceName.make("web") };
  const command = {
    command: [
      "sh",
      "-c",
      `printf '%b' '${smtpPayload}' | nc -w 5 ${MAILPIT_SHARED_NETWORK_HOST} ${MAILPIT_SMTP_PORT}`,
    ],
  };
  const result = await Effect.runPromise(exec(plan, target, command, { podmanApi: api }));
  if (result.exitCode !== 0) {
    throw new Error(
      `SMTP send from per-app service failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
};

const fetchMailpitMessages = async (timeoutMs: number): Promise<unknown> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${MAILPIT_WEB_PORT}/api/v1/messages`);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Mailpit API did not return messages within ${timeoutMs}ms: ${String(lastError)}`);
};

const messageMatches = (body: unknown): boolean => {
  const items = typeof body === "object" && body !== null && "messages" in body ? body.messages : undefined;
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const subject = "Subject" in item ? item.Subject : undefined;
    const to = "To" in item ? item.To : undefined;
    return String(subject).includes(SUBJECT) && JSON.stringify(to).includes(RECIPIENT);
  });
};

const waitForCapturedMessage = async (timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastBody: unknown;
  while (Date.now() < deadline) {
    lastBody = await fetchMailpitMessages(10_000);
    if (messageMatches(lastBody)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Mailpit did not capture expected message: ${JSON.stringify(lastBody)}`);
};

describe("global Mailpit capture — live integration", () => {
  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "captures SMTP mail sent from a per-app service over the shared cross-app network",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
      expect(socketPath).toBeTruthy();

      const api = makePodmanApiClient(socketPath);
      const globalPlan = appPlan("global", mailpitService());
      const shopPlan = appPlan("shop", senderService());

      try {
        const mailpitApplied = await Effect.runPromise(bringUp(globalPlan, { podmanApi: api }));
        expect(mailpitApplied.changed).toBe(true);

        const shopApplied = await Effect.runPromise(bringUp(shopPlan, { podmanApi: api }));
        expect(shopApplied.changed).toBe(true);

        // Wait for Mailpit's API to come up before driving SMTP from the per-app
        // service, then assert the message lands in Mailpit's API.
        await fetchMailpitMessages(120_000);
        await sendMailFromService(shopPlan, api);
        await waitForCapturedMessage(120_000);
      } finally {
        await Effect.runPromise(Effect.either(bringDown(shopPlan, { podmanApi: api })));
        await Effect.runPromise(Effect.either(bringDown(globalPlan, { podmanApi: api })));
      }
    },
    240_000,
  );
});
