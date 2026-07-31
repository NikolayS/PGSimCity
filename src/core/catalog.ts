import { NIGHT_PALETTE } from './themes'
import type { TableDef } from './types'

/* The shared relation inventory is model input, not city geography. Keeping it
 * in core prevents a layout edit from changing workload or storage behavior. */
export const TABLES: TableDef[] = [
  {
    id: 'accounts',
    name: 'accounts',
    blurb: 'Balances updated in place. Most updates are HOT, so indexes stay quiet.',
    pages: 217088,
    tuplesPerPage: 60,
    weight: 3,
    hotFriendly: 0.85,
    color: NIGHT_PALETTE.storage,
    indexes: [{ id: 'accounts_pkey', name: 'accounts_pkey', kind: 'btree', pages: 26816 }],
  },
  {
    id: 'orders',
    name: 'orders',
    blurb: 'Classic OLTP table: inserts plus status updates, read through two indexes.',
    pages: 150336,
    tuplesPerPage: 45,
    weight: 2.4,
    hotFriendly: 0.35,
    color: NIGHT_PALETTE.backend,
    indexes: [
      { id: 'orders_pkey', name: 'orders_pkey', kind: 'btree', pages: 20032 },
      { id: 'orders_cust_idx', name: 'orders_customer_id_idx', kind: 'btree', pages: 15872 },
    ],
  },
  {
    id: 'events',
    name: 'events',
    blurb: 'Append-only log. Nothing is ever updated, so autovacuum only freezes it.',
    pages: 434304,
    tuplesPerPage: 90,
    weight: 1.6,
    hotFriendly: 1,
    color: NIGHT_PALETTE.wal,
    indexes: [{ id: 'events_ts_idx', name: 'events_created_at_idx', kind: 'btree', pages: 35072 }],
  },
  {
    id: 'sessions',
    name: 'sessions',
    blurb: 'Small and rewritten constantly — the table that teaches you about bloat.',
    pages: 35072,
    tuplesPerPage: 70,
    weight: 2.8,
    hotFriendly: 0.15,
    color: NIGHT_PALETTE.checkpoint,
    indexes: [
      { id: 'sessions_pkey', name: 'sessions_pkey', kind: 'btree', pages: 4992 },
      { id: 'sessions_exp_idx', name: 'sessions_expires_idx', kind: 'btree', pages: 4608 },
    ],
  },
  {
    id: 'documents',
    name: 'documents',
    blurb: 'Wide rows: big values are pushed out to TOAST and searched with GIN.',
    pages: 75136,
    tuplesPerPage: 12,
    weight: 1.1,
    hotFriendly: 0.4,
    color: NIGHT_PALETTE.vacuum,
    toast: true,
    indexes: [
      { id: 'documents_pkey', name: 'documents_pkey', kind: 'btree', pages: 7552 },
      { id: 'documents_gin', name: 'documents_body_gin', kind: 'gin', pages: 21696 },
    ],
  },
]

export const N_TABLES = TABLES.length
