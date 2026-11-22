export const drupalTool = (tool: "drush" | "phpcs" | "phpcbf" | "phpstan", description: string) =>
  ({ service: "appserver", description, cmd: [":drupal-local", tool], wrapper: true }) as const;

export const siteDrush = drupalTool("drush", "Run Drush inside the appserver service.");

export const siteQualityTooling = {
  phpcs: drupalTool("phpcs", "Run PHP_CodeSniffer inside the appserver service."),
  phpcbf: drupalTool("phpcbf", "Run phpcbf inside the appserver service."),
  phpstan: drupalTool("phpstan", "Run PHPStan inside the appserver service."),
} as const;
