import { describe, expect, test } from "bun:test";
import { Clock, DateTime, Effect } from "effect";

import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { bringDown, bringUp, exec, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  CurrentExecutableAppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { MAILPIT_IMAGE, MAILPIT_SMTP_PORT, MAILPIT_WEB_PORT } from "../src/mailpit-constants.ts";

const providerId = ProviderId.make("lando");
const SUBJECT = "Mailpit live integration";
const RECIPIENT = "recipient@example.lndo.site";
// Minimal base image with a busybox shell + `nc`, used to drive SMTP from inside
// a per-app service container.
const SENDER_IMAGE = "docker.io/library/alpine:3.21";
const suffix = crypto.randomUUID().slice(0, 8);
const mailpitSlug = `mailpit-live-${suffix}`;
const senderSlug = `mailpit-sender-${suffix}`;
const mailpitHost = `mailpit.${mailpitSlug}.internal`;
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const mailpitHostPort = portProbe.port;
portProbe.stop(true);
if (mailpitHostPort === undefined) throw new Error("No free loopback port was assigned.");

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-30T00:00:00Z"),
  source: "global-mailpit-live.integration.test",
  runtime: 4 as const,
};

const appPlan = (slug: string, service: ServicePlan): CurrentExecutableAppPlan =>
  CurrentExecutableAppPlan.make({
    valueModel: 1,
    id: AppId.make(slug),
    name: slug,
    slug,
    root: AbsolutePath.make(`/tmp/lando-${slug}`),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    stores: [],
    fileSync: [],
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
    { _tag: "internal", port: MAILPIT_SMTP_PORT, protocol: "tcp", name: "smtp" },
    {
      _tag: "published",
      port: MAILPIT_WEB_PORT,
      protocol: "http",
      name: "web",
      publication: { bindAddress: "127.0.0.1", hostPort: mailpitHostPort },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

// Prove SMTP reaches the explicitly addressed Mailpit service across app networks.
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
    command: ["sh", "-c", `printf '%b' '${smtpPayload}' | nc -w 5 ${mailpitHost} ${MAILPIT_SMTP_PORT}`],
  };
  const result = await Effect.runPromise(exec(plan, target, command, { api }));
  if (result.exitCode !== 0) {
    throw new Error(
      `SMTP send from per-app service failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
};

const fetchMailpitMessages = async (timeoutMs: number): Promise<unknown> => {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  let lastError: unknown;
  while ((await Effect.runPromise(Clock.currentTimeMillis)) < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${mailpitHostPort}/api/v1/messages`);
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
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  let lastBody: unknown;
  while ((await Effect.runPromise(Clock.currentTimeMillis)) < deadline) {
    lastBody = await fetchMailpitMessages(10_000);
    if (messageMatches(lastBody)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Mailpit did not capture expected message: ${JSON.stringify(lastBody)}`);
};

describe("Mailpit cross-app capture — live integration", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "captures SMTP mail sent from a per-app service over the shared cross-app network",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath ?? "";
      expect(socketPath).toBeTruthy();

      const api = makePodmanApiClient(socketPath);
      const globalPlan = appPlan(mailpitSlug, mailpitService());
      const shopPlan = appPlan(senderSlug, senderService());

      try {
        // Start the Mailpit test service.
        const mailpitApplied = await Effect.runPromise(bringUp(globalPlan, { api }));
        expect(mailpitApplied.changed).toBe(true);

        const shopApplied = await Effect.runPromise(bringUp(shopPlan, { api }));
        expect(shopApplied.changed).toBe(true);

        // Wait for Mailpit's API to come up before driving SMTP from the per-app
        // service, then assert the message lands in Mailpit's API.
        await fetchMailpitMessages(120_000);
        await sendMailFromService(shopPlan, api);
        await waitForCapturedMessage(120_000);
      } finally {
        await Effect.runPromise(Effect.result(bringDown(shopPlan, { api })));
        await Effect.runPromise(Effect.result(bringDown(globalPlan, { api })));
      }
    },
    240_000,
  );
});
