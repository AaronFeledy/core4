import { dataHelperImage } from "@lando/container-runtime/data-plane";
import type { WorkflowPerformanceLaneId } from "./workflow-performance-plan.ts";

export const imagesFor = (laneId: WorkflowPerformanceLaneId): readonly string[] => {
  // Database import and snapshot restore both stream through the data helper.
  if (laneId.startsWith("mysql-")) return ["mysql:8.0", dataHelperImage.ref];
  if (laneId.startsWith("postgres-")) return ["postgres:16", dataHelperImage.ref];
  if (laneId === "drupal-journey") return ["php:8.3-apache-bookworm", "mariadb:11.4", "traefik:v3.3"];
  if (laneId === "rails-journey") return ["ruby:3.3-slim", "postgres:16", "redis:7", "traefik:v3.3"];
  return ["node:22"];
};

// Every app starts the SSH agent sidecar by default, and the first start on a fresh runtime
// builds its image. Lanes without a running-app preparation step would otherwise time that build.
// Setup already starts the proxy.
export const globalServicesFor = (laneId: WorkflowPerformanceLaneId): readonly string[] =>
  laneId === "cold-first-start" || laneId === "drupal-journey" || laneId === "rails-journey"
    ? ["ssh-agent"]
    : [];

export const landofileFor = (laneId: WorkflowPerformanceLaneId, name: string): string => {
  const type = laneId.startsWith("mysql-")
    ? "mysql:8.0"
    : laneId.startsWith("postgres-")
      ? "postgres:16"
      : "node:22";
  return `name: ${name}\nruntime: 4\nservices:\n  ${type === "node:22" ? "app" : "database"}:\n    type: ${type}\n`;
};
