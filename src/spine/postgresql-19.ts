/* Separate the reviewed reference surface from the engine and scaled model. */
import { CLAIM_VALUES } from '../core/claims'

export const PG19_MODEL_BOUNDARY =
  `The city remains a ${CLAIM_VALUES.postgresqlVersion.referenceLabel} teaching model; PGlite runs ${CLAIM_VALUES.pgliteVersion.referenceLabel}. `
  + 'PostgreSQL 19 reference support covers WAL and vacuum progress columns plus lock, '
  + 'recovery and autovacuum-score views. Other catalog cards retain their labeled 18 reference. '
  + 'Not modeled: autovacuum scoring or parallel index vacuum, scans setting all-visible bits, '
  + 'adaptive I/O workers, effective_wal_level transitions, REPACK, WAIT FOR LSN, '
  + 'sequence replication or planner advice. Selecting 19 does not enable these mechanisms.'
