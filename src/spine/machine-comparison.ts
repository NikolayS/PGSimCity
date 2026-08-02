export const MACHINE_SYNCHRONOUS_COMMIT_COMPARISON = {
  setting: 'synchronous_commit',
  control: 'on',
  treatment: 'off',
  evidenceSource: 'model',
  finding:
    'In this model, synchronous_commit = off acknowledges before the local WAL flush. PostgreSQL may do that because off removes the client\'s durability wait; WAL still flushes later.',
  pgliteDisclosure:
    'PGlite is one in-memory connection with no standby, so it cannot measure this durability-wait difference.',
  held: [
    'SQL text',
    'one PostgreSQL execution report',
    'plan and buffer evidence',
    'modelled route and viewing pace',
    'no synchronous standby',
  ],
} as const
