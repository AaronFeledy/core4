export const DRUPAL_CONTRIB_CHROME_IMAGE = "selenium/standalone-chromium:155.0-20261010";

export const DRUPAL_CONTRIB_MINK_DRIVER_ARGS =
  '["chrome", {"browserName":"chrome","goog:chromeOptions":{"w3c":true,"args":["--headless=new","--disable-gpu","--no-sandbox"]}}, "http://chrome:4444"]';

export const contribMountTarget = (type: string, project: string): string =>
  `/app/web/${type}s/custom/${project}`;

export const mysqlSimpletestDb =
  "mysql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database/{{ services.database.creds.database }}";

export const pgsqlSimpletestDb =
  "pgsql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database/{{ url.encodeComponent(services.database.creds.database) }}";

/** The sync helper's arguments; the constraint stays one argument however many spaces it holds. */
export const contribSyncArgv = [
  "lando-drupal-contrib-sync",
  "{{ recipe.type }}",
  "{{ recipe.project }}",
  "{{ recipe.drupal }}",
] as const;
