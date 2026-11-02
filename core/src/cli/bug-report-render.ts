import type { BugReportEnvelope } from "./bug-report";
import { escapeDiagnosticText } from "./diagnostic-text";

export const renderPlainBugReport = (envelope: BugReportEnvelope): string => {
  const renderText = (text: string) => text.split("\n").map(escapeDiagnosticText).join("\n");
  const lines = [renderText(envelope.body)];
  for (const [key, value] of envelope.extra) if (key === "failures") lines.push(renderText(value));
  lines.push(...envelope.remediation.split("\n").map((line) => `  ↳ ${escapeDiagnosticText(line)}`));
  for (const error of envelope.additionalErrors ?? []) {
    const label = { rollback: "Rollback also failed", cleanup: "Cleanup also failed", peer: "Also failed" }[
      error.role
    ];
    lines.push(`${label} (${renderText(error.code)}): ${renderText(error.body).replaceAll("\n", "\n  ")}`);
    for (const [key, value] of error.extra) if (key === "failures") lines.push(renderText(value));
    lines.push(...error.remediation.split("\n").map((line) => `  ↳ ${escapeDiagnosticText(line)}`));
    for (const [key, value] of error.extra)
      if (key !== "failures")
        lines.push(`  ${renderText(key)}: ${renderText(value).replaceAll("\n", "\n  ")}`);
  }
  const details = [`code: ${renderText(envelope.code)}`, `commandId: ${renderText(envelope.commandId)}`];
  if (envelope.appId !== undefined) details.push(`appId: ${renderText(envelope.appId)}`);
  if (envelope.providerId !== undefined) details.push(`providerId: ${renderText(envelope.providerId)}`);
  for (const [key, value] of envelope.extra)
    if (key !== "failures") details.push(`${renderText(key)}: ${renderText(value)}`);
  details.push(`logsDir: ${renderText(envelope.logsDir)}`, `cacheDir: ${renderText(envelope.cacheDir)}`);
  return [...lines, ...details].join("\n");
};

export const renderJsonBugReport = (envelope: BugReportEnvelope): string => {
  const { extra, issues, failures, additionalErrors, ...base } = envelope;
  const fields = Object.fromEntries(extra.filter(([key]) => key !== "issues" && key !== "failures"));
  return JSON.stringify({
    _tag: "message.error",
    ...base,
    ...fields,
    ...(issues === undefined ? {} : { issues }),
    ...(failures === undefined ? {} : { failures }),
    ...(additionalErrors === undefined
      ? {}
      : {
          additionalErrors: additionalErrors.map(({ extra: additionalExtra, ...error }) => ({
            ...Object.fromEntries(additionalExtra.filter(([key]) => key !== "issues")),
            ...error,
          })),
        }),
    timestamp: new Date().toISOString(),
  });
};
