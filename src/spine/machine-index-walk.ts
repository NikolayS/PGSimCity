export const MACHINE_INDEX_WALK = Object.freeze({
  finding:
    'P measured on this seeded accounts table: both lookups returned one row. PostgreSQL used an Index Scan on accounts_pkey for id and a Seq Scan for owner; the catalog reported accounts_pkey on id.',
  incomplete:
    'The measured sequence is incomplete or PostgreSQL chose a different plan. Read the receipts instead of assuming the expected finding.',
  sequenceDisclosure:
    'P steps execute one after another on one in-memory PGlite connection; every receipt belongs to one completed execution.',
  modelDisclosure:
    'M board motion is a human-paced replay of each statement. It measures no concurrency and no device latency; it supplies no lock contention, standby behaviour, or real device I/O.',
  comparisonDisclosure:
    'Compare PostgreSQL plan nodes, result rows, and buffer counts—not elapsed time. Buffer counts belong to this PGlite session and are not a storage-speed benchmark.',
})
