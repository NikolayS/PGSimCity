export const MACHINE_INDEX_WALK = Object.freeze({
  catalogSql: `SELECT
  c.relname AS index_name,
  am.amname AS access_method,
  CASE WHEN i.indisvalid THEN 'valid' ELSE 'INVALID' END AS validity,
  pg_catalog.pg_get_indexdef(i.indexrelid) AS index_definition
FROM pg_catalog.pg_index AS i
JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
WHERE i.indrelid = 'accounts'::regclass
ORDER BY c.relname;`,
  finding:
    'P measured on this seeded accounts table: both lookups returned one row. PostgreSQL used an Index Scan on accounts_pkey for id and a Seq Scan for owner; the catalog reported the full valid btree definition of accounts_pkey.',
  incomplete:
    'The measured sequence is incomplete or PostgreSQL chose a different plan. Read the receipts instead of assuming the expected finding.',
  sequenceDisclosure:
    'P steps execute one after another on one in-memory PGlite connection; every receipt belongs to one completed execution.',
  modelDisclosure:
    'M board motion is a human-paced replay of each statement. It measures no concurrency and no device latency; it supplies no lock contention, standby behaviour, or real device I/O.',
  comparisonDisclosure:
    'Compare PostgreSQL plan nodes, result rows, and buffer counts—not elapsed time. Buffer counts belong to this PGlite session and are not a storage-speed benchmark.',
})
