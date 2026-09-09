/**
 * Readable source for the Backdrop settings environment blob. It lives apart
 * from the renderer so the published snapshot can carry the same text without
 * importing renderer machinery.
 */
export const backdropSettings = (database: string): string =>
  JSON.stringify({
    databases: {
      default: {
        default: {
          driver: "mysql",
          database,
          username: "lando",
          password: "lando",
          host: "database",
          port: 3306,
        },
      },
    },
  });
