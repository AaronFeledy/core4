import { renderPrimaryRouteLines } from "../php-stack";
import type { RecipeRenderer } from "../registry";
import { DJANGO_RECIPE_ID } from "./manifest";

const renderLandofile = (appName: string, celery: boolean): string => {
  const lines = [
    `name: ${appName}`,
    "runtime: 4",
    `recipe: ${DJANGO_RECIPE_ID}`,
    "services:",
    "  web:",
    "    type: python:3.12",
    "    framework: django",
    "    port: 8000",
    "    dependsOn:",
    "      - database",
    "      - cache",
    ...renderPrimaryRouteLines(appName),
    "  database:",
    "    type: postgres",
    "  cache:",
    "    type: redis",
  ];
  if (celery) {
    lines.push(
      "  worker:",
      "    type: python:3.12",
      "    framework: django",
      "    command: celery -A app worker --loglevel=info",
      "    dependsOn:",
      "      - database",
      "      - cache",
    );
  }
  lines.push(
    "tooling:",
    "  django:",
    "    service: web",
    "    description: Run the Django management script inside the web service.",
    "    cmds:",
    "      - python manage.py",
    "  pip:",
    "    service: web",
    "    description: Run pip inside the web service.",
    "    cmds:",
    "      - pip",
    "",
  );
  return lines.join("\n");
};

export const djangoRenderer: RecipeRenderer = {
  id: DJANGO_RECIPE_ID,
  render: ({ appName, answers }) => {
    const celery = answers.celery === true || answers.celery === "true";
    return new Map([[".lando.yml", renderLandofile(appName, celery)]]);
  },
};
