/* PGlite's compiled server version is independent of the city's teaching target. */
const PGLITE_PACKAGE_VERSION = '0.5.4'
const PGLITE_POSTGRESQL_VERSION = '18.3'

export const PGLITE_VERSION = {
  packageVersion: PGLITE_PACKAGE_VERSION,
  postgresqlVersion: PGLITE_POSTGRESQL_VERSION,
  referenceLabel: `PostgreSQL ${PGLITE_POSTGRESQL_VERSION}`,
  reportedPrefix:
    `PostgreSQL ${PGLITE_POSTGRESQL_VERSION} (PGlite ${PGLITE_PACKAGE_VERSION})`,
  versionQuery: 'SELECT version() AS version',
} as const
