# PostgreSQL operational-advice pressure test

## Result

This review asks whether a tired operator following PGSimCity's advice would
improve the incident. It does not repeat the existing claim oracle. I staged
the highest-cost Diagnose and scenario actions on PostgreSQL 13.23, 17.9, and
18.3 and then followed the displayed advice literally.

The result is three high-cost and two medium-cost findings. Three other
high-risk actions behaved as advertised on all three majors. No city content
was changed.

| Cost if followed | Surface | Result |
|---|---|---|
| High | Replay-lag verdict and scenario | A paused standby has exactly the advertised LSN shape. Reducing primary WAL did not move replay; `pg_wal_replay_resume()` did. |
| High | Connection saturation gate and idle verdict | Reserved slots let application connections fail while the saturation gate is false and the idle gate is true. |
| High | Replay/slot-limit advice | A 32 MiB `max_slot_wal_keep_size` protected the primary by invalidating a required slot; the detached standby could no longer catch up. The displayed action omits that cost. |
| Medium | Autovacuum Diagnose branch | Global autovacuum was on, no xmin holder existed, and tuning did nothing because the affected table had `autovacuum_enabled=false`. Diagnose never reads relation options. |
| Medium | Autovacuum worker advice | Raising `autovacuum_max_workers` is live after reload on 18, but requires a server restart on 13 and 17. The advice does not disclose the version boundary. |
| Sound | Lock-holder verdict and lock-pileup scenario | Canceling an idle holder did not release its lock; terminating the verified holder did, exactly as displayed. |
| Sound | xmin verdict and scenario | The old snapshot made VACUUM report dead rows as not removable; ending it made the next VACUUM remove them. |
| Sound | Slot-pressure decision and result prose | Dropping an inactive slot did not delete already-present WAL. A standby restarted without `primary_slot_name` and replayed all 121,000 rows. |

This is a deliberately selected audit, not an assertion that every one of the
31 SQL blocks, every restore path, or every failover path was exercised in this
pass. Unstaged recovery and failover prose gets no clean verdict here.

## Method and common harness

Each experiment used a new data directory, a port probed by binding to port
zero, and the binaries from the major under test. The effective harness was:

```bash
set -Eeuo pipefail
free_port() {
  node -e "const n=require('net').createServer();n.listen({host:'127.0.0.1',port:0},()=>{console.log(n.address().port);n.close()})"
}

for v in 13 17 18; do
  pg_bin="/usr/lib/postgresql/$v/bin"
  scratch="$(mktemp -d "/tmp/pgcity-advice-v${v}-XXXXXX")"
  data_dir="$scratch/data"
  socket_dir="$scratch/socket"
  port="$(free_port)"
  mkdir "$socket_dir"

  "$pg_bin/initdb" -D "$data_dir" \
    --no-locale --encoding=UTF8 --auth=trust \
    --username=postgres --no-sync
  "$pg_bin/pg_ctl" -D "$data_dir" -l "$scratch/postgres.log" \
    -o "-h 127.0.0.1 -p $port -k $socket_dir -c fsync=off" \
    -w start
done
```

Replication experiments used a second probed port and socket directory plus
`pg_basebackup -X stream -C -S <slot> -R`. `fsync=off`, `--no-sync`, and, in
the slot-limit experiment, `full_page_writes=off` reduced fixture time. None of
the verdicts below depends on crash durability or elapsed-time performance.
Servers were stopped after every observation.

## Findings, ranked by operational cost

### 1. High — the replay verdict does not exclude paused recovery

**Surface:** `src/observability/paths.ts:1550-1566`, especially the title “A
standby is receiving fine. It cannot replay fast enough” and the action:

> Reduce the WAL the primary produces, or accept the lag and route reads that
> need currency to the primary. ... And set max_slot_wal_keep_size ...

The same capacity framing appears at `src/sim/scenarios.ts:277-281`. The more
cautious inspector text at `src/ui/docs-storage.ts:1052-1053` says the gaps
localise investigation but do not prove a root cause; that qualification is
absent from the verdict's action.

**Commands run.** For each major I created a primary, created `replay_probe`,
took a base backup into a standby using physical slot `advice_slot`, and ran:

```bash
"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$standby_port" \
  -U postgres -d postgres -c "SELECT pg_wal_replay_pause();"

"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$primary_port" \
  -U postgres -d postgres -c \
  "INSERT INTO replay_probe
     SELECT g,repeat(md5(g::text),20)
       FROM generate_series(1001,61000) g;
   SELECT pg_switch_wal();"

# Poll until current_lsn - flush_lsn <= 8192, then stop all client writes.
"$pg_bin/psql" -X -A -F '|' -q -h 127.0.0.1 \
  -p "$primary_port" -U postgres -d postgres -c \
  "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),sent_lsn)::bigint AS current_sent,
          pg_wal_lsn_diff(sent_lsn,write_lsn)::bigint AS sent_write,
          pg_wal_lsn_diff(write_lsn,flush_lsn)::bigint AS write_flush,
          pg_wal_lsn_diff(flush_lsn,replay_lsn)::bigint AS flush_replay
     FROM pg_stat_replication;"

"$pg_bin/psql" -X -A -F '|' -q -h 127.0.0.1 \
  -p "$standby_port" -U postgres -d postgres -c \
  "SELECT pg_is_wal_replay_paused(),
          pg_wal_lsn_diff(pg_last_wal_receive_lsn(),
                          pg_last_wal_replay_lsn())::bigint AS receive_replay,
          (SELECT count(*) FROM replay_probe) AS visible_rows;"
```

PostgreSQL 13, 17, and 18 all returned the same readings:

```text
current_sent|sent_write|write_flush|flush_replay
0|0|0|50331728
(1 row)

pg_is_wal_replay_paused|receive_replay|visible_rows
t|50331728|1000
(1 row)
```

On 18 I then stopped writes for another second and repeated the standby query:

```text
pg_is_wal_replay_paused|receive_replay|visible_rows
t|50331728|1000
(1 row)
```

Following the displayed “reduce the WAL” move therefore did not resolve the
incident. The omitted first check did:

```bash
"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$standby_port" \
  -U postgres -d postgres -c "SELECT pg_wal_replay_resume();"
```

All three majors then returned:

```text
pg_is_wal_replay_paused|receive_replay|visible_rows
f|0|61000
(1 row)
```

The 18 server log also stated the remedy exactly:

```text
LOG:  recovery has paused
HINT:  Execute pg_wal_replay_resume() to continue.
```

**Operational consequence.** The LSN branch distinguishes transmission from
apply, but it cannot distinguish slow replay from paused replay. Following the
capacity advice can shed primary writes or leave users on stale data while the
standby remains stopped indefinitely. Before changing workload or retention,
the operator needs to check `pg_is_wal_replay_paused()`, the startup process and
its wait event, `pg_stat_wal_receiver`, and the standby log. The failure and
the remedy were identical on 13, 17, and 18.

### 2. High — reserved slots make the connection gate miss a real outage

**Surface:** the gate is owned at `src/core/claims.ts:207-212` and applied at
`src/observability/paths.ts:713-724`. It marks saturation only when the client
backend total is at least `max_connections - 1`. The competing action at
`src/observability/paths.ts:1698-1708` says:

> Almost every backend is idle. Whatever is slow, the database is not
> currently the thing that is slow.

When the saturation branch does fire, `src/observability/paths.ts:1658-1672`
recommends putting a measured pool in front of PostgreSQL.

**Commands run.** I started each major with eight total connections and three
superuser-reserved connections, then held all five ordinary application slots
open in plain `idle` state:

```bash
"$pg_bin/pg_ctl" -D "$data_dir" -l "$log_file" \
  -o "-h 127.0.0.1 -p $port -k $socket_dir -c fsync=off \
      -c max_connections=8 -c superuser_reserved_connections=3" \
  -w start
"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$port" \
  -U postgres -d postgres -c "CREATE ROLE app LOGIN;"

for i in 1 2 3 4 5; do
  { printf 'SELECT 1;\n'; sleep 12; } |
    "$pg_bin/psql" -X -q -h 127.0.0.1 -p "$port" \
      -U app -d postgres >"$scratch/client-$i.out" 2>&1 &
done
sleep 1

"$pg_bin/psql" -X -A -F '|' -q -h 127.0.0.1 -p "$port" \
  -U postgres -d postgres -c \
  "WITH a AS (
     SELECT state,count(*) n
       FROM pg_stat_activity
      WHERE backend_type='client backend'
      GROUP BY state
   ), t AS (
     SELECT sum(n) total,
            coalesce(sum(n) FILTER (WHERE state='idle'),0) idle,
            coalesce(sum(n) FILTER (WHERE state='idle in transaction'),0) idle_tx
       FROM a
   )
   SELECT total,idle,idle_tx,
          current_setting('max_connections') AS max_connections,
          current_setting('superuser_reserved_connections') AS superuser_reserved,
          total >= current_setting('max_connections')::int - 1 AS city_saturation_gate,
          total - idle < 3 AS city_idle_gate
     FROM t;"

"$pg_bin/psql" -X -A -t -q -h 127.0.0.1 -p "$port" \
  -U app -d postgres -c "SELECT 'admitted';"
```

All three majors produced the same gate result:

```text
total|idle|idle_tx|max_connections|superuser_reserved|city_saturation_gate|city_idle_gate
6|5|0|8|3|f|t
(1 row)
```

The sixth counted row is the diagnostic superuser session using reserved
capacity. A new application connection was already impossible. PostgreSQL 13
said:

```text
psql: error: connection to server at "127.0.0.1", port 38143 failed:
FATAL:  remaining connection slots are reserved for non-replication superuser connections
```

PostgreSQL 17 and 18 said:

```text
FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute
```

I separately repeated the test with every ordinary slot held `idle in
transaction` and attempted the server login that a newly introduced pooler
would need. On all majors the direct login and the proposed pooler's server
login received the same reserved-slot FATAL. After this command:

```sql
SELECT pg_terminate_backend(min(pid))
  FROM pg_stat_activity
 WHERE usename='app'
   AND state='idle in transaction';
```

the exact result was:

```text
t
pooler server admitted
```

**Operational consequence.** During a complete application connection outage,
Diagnose can leave the saturation branch unmarked and mark “Hardly anything is
running at all.” The idle verdict then sends the operator upstream even though
PostgreSQL is refusing the login by design. A pool is useful prevention, but a
new pool cannot open its first server connection while ordinary capacity is
already exhausted. The first incident move is to calculate capacity after
reserved slots, use protected administrative access, identify session owners,
and release only verified abandoned sessions before changing the admission
architecture. This failure reproduced on 13, 17, and 18.

### 3. High — the slot-cap action omits that it can strand the standby

**Surface:** `src/observability/paths.ts:1565-1566` tells the operator to set
`max_slot_wal_keep_size`; `src/sim/scenarios.ts:280-281` repeats that action so
a dead slot cannot consume the volume. Neither action says that enforcing the
cap intentionally permits required WAL to be removed. The inspector does say
this at `src/ui/docs-storage.ts:1048-1049`, and the safer slot-pressure path at
`src/observability/paths.ts:1209-1210` first asks for ownership and recovery
intent. The high-cost problem is the inconsistent action text on the replay
surfaces.

**Commands run.** I created a required physical slot and standby with no
archive recovery, stopped the standby, and followed the recommendation with a
32 MiB cap:

```bash
"$pg_bin/pg_ctl" -D "$primary" -l "$primary_log" \
  -o "-h 127.0.0.1 -p $primary_port -k $primary_sock \
      -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
      -c wal_level=replica -c max_wal_senders=5 \
      -c max_replication_slots=5 -c wal_keep_size=0 \
      -c max_wal_size=64MB -c min_wal_size=32MB \
      -c max_slot_wal_keep_size=32MB" -w start

"$pg_bin/pg_basebackup" -h 127.0.0.1 -p "$primary_port" \
  -U postgres -D "$standby" -X stream -C -S required_slot -R
"$pg_bin/pg_ctl" -D "$standby" -m fast -w stop

"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$primary_port" \
  -U postgres -d postgres -c \
  "INSERT INTO slot_probe
     SELECT g,repeat(md5(g::text),30)
       FROM generate_series(1001,181000) g;
   SELECT pg_switch_wal(); CHECKPOINT;
   SELECT pg_switch_wal(); CHECKPOINT;"
```

Before disconnection, 17 and 18 reported:

```text
slot_name|active|wal_status|safe_wal_size|cap
required_slot|t|reserved|50331648|32MB
(1 row)
```

After cap enforcement they both reported:

```text
slot_rows|slot_name|active|wal_status|safe_wal_size
1|required_slot|f|lost|
(1 row)
primary_rows
181000
(1 row)
```

On 13, the primary log recorded:

```text
LOG:  invalidating slot "required_slot" because its restart_lsn 0/2000000 exceeds max_slot_wal_keep_size
```

Restarting the standby left it in recovery with no connected walsender on all
three majors:

```text
connected_walsenders
0
(1 row)
pg_is_in_recovery|standby_rows
t|1000
(1 row)
```

PostgreSQL 13 and 17 reported the missing segment:

```text
FATAL:  could not receive data from WAL stream: ERROR:  requested WAL segment 000000010000000000000003 has already been removed
```

PostgreSQL 18 made the policy consequence more explicit:

```text
FATAL:  could not start WAL streaming: ERROR:  can no longer access replication slot "required_slot"
DETAIL:  This replication slot has been invalidated due to "wal_removed".
```

**Operational consequence.** The cap saved primary disk by spending the
standby's retention guarantee. Without an archive containing the removed WAL,
the only recovery was a new base backup. That is sometimes the correct trade,
but it is not a harmless guard and it is not the first move for a standby whose
continuity is required. Ownership, recovery intent, archive coverage, time to
volume exhaustion, catch-up rate, and accepted rebuild cost have to be decided
before the value is enforced. The destructive boundary exists on 13, 17, and
18; only the error reporting improved.

### 4. Medium — Diagnose does not inspect per-table autovacuum disablement

**Surface:** `src/observability/paths.ts:835-849` reads only the global
`autovacuum` setting. If it is on, `src/observability/paths.ts:853-886` checks
horizon candidates and then sends the operator to the tuning verdict at
`src/observability/paths.ts:1351-1362`:

> Lower autovacuum_vacuum_scale_factor per table ... and raise
> autovacuum_max_workers and the cost limits ...

The displayed SQL never reads `pg_class.reloptions`.

**Commands run.** On each major I enabled global autovacuum, shortened
`autovacuum_naptime`, configured five workers, and created one table that opted
out:

```bash
"$pg_bin/pg_ctl" -D "$data_dir" -l "$log_file" \
  -o "-h 127.0.0.1 -p $port -k $socket_dir -c fsync=off \
      -c autovacuum=on -c autovacuum_naptime=1s \
      -c autovacuum_max_workers=5 -c log_autovacuum_min_duration=0" \
  -w start

"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$port" \
  -U postgres -d postgres -c \
  "CREATE TABLE av_probe(id integer PRIMARY KEY, v integer NOT NULL)
     WITH (autovacuum_enabled=false);
   INSERT INTO av_probe SELECT g,g FROM generate_series(1,30000) g;
   CREATE INDEX av_probe_v_idx ON av_probe(v);
   ANALYZE av_probe;
   UPDATE av_probe SET v=v+1;"
```

On 17 and 18, the inputs seen by the Diagnose path were:

```text
global_autovacuum|workers|reloptions|n_live_tup|n_dead_tup|last_autovacuum|autovacuum_count
on|5|{autovacuum_enabled=false}|30000|30000||0
(1 row)
other_xmin_candidates
0
(1 row)
```

PostgreSQL 13 had the same 30,000 dead tuples and no other xmin candidate. I
then followed the displayed tuning while leaving the cause untouched:

```sql
ALTER TABLE av_probe SET (
  autovacuum_vacuum_scale_factor=0.01,
  autovacuum_vacuum_cost_limit=10000
);
```

After three seconds, every major still reported:

```text
reloptions|n_dead_tup|last_autovacuum|autovacuum_count
{autovacuum_enabled=false,autovacuum_vacuum_scale_factor=0.01,autovacuum_vacuum_cost_limit=10000}|30000||0
(1 row)
```

Reading and correcting the relation option resolved it on the next launcher
pass:

```sql
ALTER TABLE av_probe SET (autovacuum_enabled=true);
```

The exact result on each major was `n_dead_tup=0` and
`autovacuum_count=1`; for example, 18 returned:

```text
reloptions|n_dead_tup|last_autovacuum|autovacuum_count
{autovacuum_vacuum_scale_factor=0.01,autovacuum_vacuum_cost_limit=10000,autovacuum_enabled=true}|0|2026-08-04 22:50:21.498186+00|1
(1 row)
```

**Operational consequence.** The advice spends incident time changing
thresholds and capacity when the launcher is explicitly forbidden to choose
the relation. The materially better first check is the target relation's
storage parameters (and the actual child relations in a partitioned layout),
before global worker tuning.

### 5. Medium — raising autovacuum workers is silently version-specific

**Surface:** the same action at `src/observability/paths.ts:1361-1362` and the
scenario advice at `src/sim/scenarios.ts:185` say to raise
`autovacuum_max_workers`. They do not state whether that is a live incident
control.

**Commands run.** With each server running at five workers, I changed the
setting to six and reloaded:

```bash
"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$port" \
  -U postgres -d postgres -c \
  "ALTER SYSTEM SET autovacuum_max_workers=6;"
"$pg_bin/psql" -X -A -t -q -h 127.0.0.1 -p "$port" \
  -U postgres -d postgres -c "SELECT pg_reload_conf();"
"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$port" \
  -U postgres -d postgres -c "SELECT pg_sleep(0.5);"
"$pg_bin/psql" -X -A -F '|' -q -h 127.0.0.1 -p "$port" \
  -U postgres -d postgres -c \
  "SELECT name,setting,context,pending_restart
     FROM pg_settings
    WHERE name='autovacuum_max_workers';"
```

PostgreSQL 13 and 17 both returned:

```text
name|setting|context|pending_restart
autovacuum_max_workers|5|postmaster|t
(1 row)
```

PostgreSQL 18 returned:

```text
name|setting|context|pending_restart
autovacuum_max_workers|6|sighup|f
(1 row)
```

**Operational consequence.** On 13 and 17, an operator can follow the action,
reload successfully, and still have exactly the old worker capacity. Applying
it requires accepting a server restart; on 18, reload is sufficient. That is a
material difference during an incident, both because an unnoticed pending
restart leaves the attempted fix inert and because restarting solely to make
this knob live adds avoidable outage risk.

## Advice that survived literal execution

### Lock holder: sound on 13, 17, and 18

**Surface:** `src/observability/paths.ts:1499-1511` and
`src/sim/scenarios.ts:240-245` say to end the holder's transaction, warn that
`pg_cancel_backend()` cannot clear an idle-in-transaction holder, and require
PID/owner/abort verification before `pg_terminate_backend()`.

I held `LOCK TABLE lock_probe IN ACCESS EXCLUSIVE MODE` in an idle transaction,
started a blocked reader, and ran:

```sql
SELECT pg_cancel_backend(pid)
  FROM pg_stat_activity
 WHERE state='idle in transaction'
   AND query LIKE 'LOCK TABLE lock_probe%';

SELECT count(*)
  FROM pg_stat_activity
 WHERE wait_event_type='Lock'
   AND cardinality(pg_blocking_pids(pid)) > 0;

SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE state='idle in transaction'
   AND query LIKE 'LOCK TABLE lock_probe%';
```

Each major returned the same sequence:

```text
pg_cancel_backend(holder): t
remaining blocked readers: 1
pg_terminate_backend(holder): t
remaining blocked readers: 0
```

The reader then completed with:

```text
 id
----
  1
(1 row)
```

The displayed advice resolves the incident and warns about the destructive
part at the right point.

### xmin holder: sound on 13, 17, and 18

**Surface:** `src/observability/paths.ts:1277-1289` and
`src/sim/scenarios.ts:210-217` say to release a verified old transaction, then
let the next vacuum collect the now-removable rows.

I held a `REPEATABLE READ` snapshot over `xmin_probe`, updated every one of its
rows from another session, and ran `VACUUM (VERBOSE)`. PostgreSQL 13 said:

```text
INFO:  "xmin_probe": found 0 removable, 10000 nonremovable row versions in 45 out of 45 pages
DETAIL:  5000 dead row versions cannot be removed yet, oldest xmin: 486
```

After terminating the verified holder, the next vacuum said:

```text
INFO:  "xmin_probe": removed 5000 row versions in 23 pages
DETAIL:  0 dead row versions cannot be removed yet, oldest xmin: 487
n_dead_tup|last_vacuum
0|2026-08-04 22:52:09.119859+00
```

PostgreSQL 17 and 18 used newer verbose wording but produced the same outcome:

```text
tuples: 0 removed, 40000 remain, 20000 are dead but not yet removable
```

then:

```text
tuples: 20000 removed, 20000 remain, 0 are dead but not yet removable
n_dead_tup|last_vacuum
0|<vacuum timestamp>
```

The prose also correctly says that the damage outlives the cause: releasing the
snapshot made the tuples eligible; the following vacuum did the actual cleanup.

### Dropping a detached physical slot: corrected advice is sound

**Surface:** `src/observability/paths.ts:1209-1210`,
`src/sim/scenarios.ts:505-507`, and `src/ui/hud.ts:2026-2029` say that dropping a
slot removes the guarantee but does not delete WAL already present, and that a
base backup is required only if the needed WAL is unavailable from every
source.

I stopped a caught-up standby, inserted 120,000 more rows, switched WAL,
dropped its inactive slot, and restarted with an empty `primary_slot_name`:

```bash
"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$primary_port" \
  -U postgres -d postgres -c \
  "INSERT INTO drop_probe
     SELECT g,repeat(md5(g::text),20)
       FROM generate_series(1001,121000) g;
   SELECT pg_switch_wal();"

"$pg_bin/psql" -X -q -h 127.0.0.1 -p "$primary_port" \
  -U postgres -d postgres -c \
  "SELECT pg_drop_replication_slot('required_slot');"

"$pg_bin/pg_ctl" -D "$standby" -l "$standby_log" \
  -o "-h 127.0.0.1 -p $standby_port -k $standby_sock \
      -c fsync=off -c primary_slot_name=''" -w start
```

On 17 and 18 the slot held 100,663,296 bytes just before it was dropped. Both
then returned:

```text
slots
0
(1 row)
walsenders
1
(1 row)
primary_rows
121000
(1 row)
primary_slot_name|standby_rows
|121000
(1 row)
```

PostgreSQL 13 also returned an empty `primary_slot_name` and 121,000 standby
rows. No archive was configured and no base backup was taken after the drop.
The required WAL was still in `pg_wal`, so all three standbys continued exactly
as the revised prose says. This is materially different from the slot-cap
experiment: in that test checkpoints had already removed the required segment.
