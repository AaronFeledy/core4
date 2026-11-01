import { type EndpointPlan, PortNumber, type ServiceConfig } from "@lando/sdk/schema";
import { MAILPIT_SMTP_PORT, MAILPIT_WEB_PORT } from "../mailpit-constants.ts";
import { ServiceConfigIssue } from "./_feature-helpers.ts";
import { assertListenerConfig } from "./_port-helpers.ts";

const WILDCARD_BIND_REMEDIATION =
  "Use :port, 0.0.0.0:port, or [::]:port for app-network reachability, or manage the listener explicitly with a Compose service.";

const nativeBind = (service: ServiceConfig, variable: string, fallback: string) => {
  const address = service.environment?.[variable] ?? fallback;
  if (typeof address !== "string") {
    throw new ServiceConfigIssue(
      ["environment", variable],
      `${variable} requires a literal wildcard bind address.`,
      WILDCARD_BIND_REMEDIATION,
    );
  }
  const match = /^(?:0\.0\.0\.0|\[::\])?:([0-9]+)$/.exec(address);
  const port = Number(match?.[1]);
  if (match === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceConfigIssue(
      ["environment", variable],
      `${variable} requires a literal bind address with a TCP port from 1 to 65535.`,
      WILDCARD_BIND_REMEDIATION,
    );
  }
  return { address, port: PortNumber.make(port) };
};

export const resolveMailListeners = (service: ServiceConfig, type: "mailpit" | "mailhog") => {
  const prefix = type === "mailpit" ? "MP" : "MH";
  const smtpPort = service.port ?? MAILPIT_SMTP_PORT;
  const smtpVariable = `${prefix}_SMTP_BIND_ADDR`;
  const smtp = nativeBind(service, smtpVariable, `0.0.0.0:${smtpPort}`);
  if (smtp.port !== smtpPort) {
    throw new ServiceConfigIssue(
      ["environment", smtpVariable],
      `${smtpVariable} must match the primary SMTP port.`,
      `Set its port to ${smtpPort}, change port: to match, or omit ${smtpVariable}.`,
    );
  }
  const ui = nativeBind(service, `${prefix}_UI_BIND_ADDR`, `0.0.0.0:${MAILPIT_WEB_PORT}`);
  const api =
    type === "mailhog" ? nativeBind(service, "MH_API_BIND_ADDR", `0.0.0.0:${MAILPIT_WEB_PORT}`) : ui;
  if (ui.address !== api.address && ui.port === api.port) {
    throw new ServiceConfigIssue(
      ["environment", "MH_API_BIND_ADDR"],
      "MailHog opens separate HTTP sockets when UI and API bind addresses differ, but their ports collide.",
      "Use identical MH_UI_BIND_ADDR and MH_API_BIND_ADDR strings to share one listener, or use distinct ports.",
    );
  }
  assertListenerConfig(service, {
    port: MAILPIT_SMTP_PORT,
    daemon: type,
    reserved: [
      { port: ui.port, use: "HTTP UI listener" },
      { port: api.port, use: "HTTP API listener" },
    ],
  });
  const endpoints: readonly EndpointPlan[] = [
    { _tag: "internal", port: PortNumber.make(smtpPort), protocol: "tcp", name: "smtp", primary: true },
    { _tag: "internal", port: ui.port, protocol: "http", name: "ui", scan: { path: "/" } },
    ...(ui.address === api.address
      ? []
      : [
          {
            _tag: "internal" as const,
            port: api.port,
            protocol: "http" as const,
            name: "api",
            scan: { path: "/api/v2/messages" },
          },
        ]),
  ];
  return { smtpAddress: smtp.address, endpoints };
};
