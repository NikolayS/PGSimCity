export const MACHINE_SYNCHRONOUS_COMMIT_COMPARISON = {
  setting: 'synchronous_commit',
  control: 'on',
  treatment: 'off',
  evidenceSource: 'model',
  finding:
    'In this model, synchronous_commit = off acknowledges before the local WAL flush, removing that client wait; WAL still flushes later. A crash can lose acknowledged commits from the recent window — up to roughly 3 × wal_writer_delay. Transactions stay atomic, and this setting does not corrupt data; it is not fsync = off.',
  pgliteDisclosure:
    'PGlite uses one in-memory connection with no standby or real device durability, so it cannot measure this difference.',
  replayDisclosure:
    'One P execution is reused by both M replays, so P noise stays fixed. synchronous_commit is not SET or re-executed in PGlite.',
  held: [
    'SQL text',
    'one PostgreSQL execution report',
    'plan and buffer evidence',
    'modelled route and viewing pace',
    'no synchronous standby',
  ],
} as const
