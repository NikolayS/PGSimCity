# Investigation outcomes

The two-case vacuum practice uses the same city simulation. Its objective is to
establish the cleanup constraint, respect the application owner's requirement,
and verify resumed cleanup. It does not run PostgreSQL or execute a report.

| Case | Authored operational context | Appropriate intervention |
| --- | --- | --- |
| Vacuum blockade | The owner confirms an abandoned read-only transaction and no work to preserve. | End the session, then verify cleanup. |
| Required report | The client is processing results between statements and still needs its REPEATABLE READ snapshot. The owner accepts temporary growth and has headroom for this case. | Preserve the transaction until authored client completion, then verify cleanup. |

In the report case, choosing to wait starts a scripted 30-model-second interval.
This is an authored client-completion event, not a database estimate, a report
executor, or a production guarantee. Ending the session interrupts report work;
it does not delete committed data. No database ownership measurement is implied.

Ending either transaction releases its snapshot. Row versions eligible before
that release may already have been collected. Recovery therefore requires a
positive increase in the model's collection counter **after** the release, not
merely a positive total since the decision. A required report interrupted by
termination cannot earn lesson completion even if cleanup resumes.

PostgreSQL preserves the REPEATABLE READ snapshot across successive statements
in a transaction ([transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-REPEATABLE-READ)).
Session termination ends the session, unlike cancellation of a running query
([administration functions](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)).
VACUUM can reclaim versions no longer needed by transactions and normally makes
space reusable inside the existing file; file shrinkage is not the success test
([routine vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html)).

## Links, retries and local progress

Use `#lesson/vacuum-blockade/guided`,
`#lesson/vacuum-blockade/challenge`, or
`#lesson/vacuum-report/challenge`. The corresponding guided report link is also
supported. Links contain no notebook, SQL or current simulation state.

A new case or retry clears the notebook and starts from the current city. It is
not a rewind. The incident replay control is the separate reproducible retry
path. Switching only guided/challenge mode retains the current notebook; prior
guidance still counts as guidance used. Rewind removes evidence from the future
and requires another recovery check, without recording duplicate completions.

The local-storage key `pgsimcity.lessons.v1` holds only a version and, for each
allowlisted case, a bounded attempt count, verified-completion flag and
first-recorded-challenge-recovery flag. Storage denial or malformed data does not
block the lesson. It contains no identifiers, timestamps, notes or queries.

Aggregate events are Lesson Started, Lesson Hint Used, Lesson Evidence Collected,
Lesson Recovery Verified and Lesson Completed. Only the case ID, mode and boolean
first-encounter/unassisted dimensions are allowed, alongside the existing city
entrypoint. A completion requires both observed recovery and the case's business
constraint. Report interruption is not falsely credited as data loss or success.

## What remains to evaluate

These are interaction outcomes, not a measured improvement in operator skill.
First recorded attempt means first in this browser's surviving local record;
cleared storage, other devices and prior knowledge are unknown. No usability
study has been performed by this implementation.

To evaluate transfer, give engineers who know SQL but have not operated
PostgreSQL the first case with guidance, then the other case without hints.
Observe whether they seek ownership context, choose the changed intervention,
and verify actual cleanup. Record misunderstandings separately from completion
counts. Independent PostgreSQL/operations and browser reviews remain release
gates; automated tests alone do not establish teaching quality.
