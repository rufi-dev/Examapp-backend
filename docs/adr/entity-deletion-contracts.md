# Entity deletion contracts

Status: Accepted for the remediation working tree  
Date: 2026-07-27

## Invariants

1. User-facing delete means archive/disable unless a separate reviewed purge is
   explicitly requested.
2. Results, Attempts, ExamVersions, and their Exam tombstone are historical
   grading evidence. They are never silently orphaned.
3. Session revocation is the first security boundary of account deletion.
4. Database references commit before private-file deletion. File removal uses
   the durable fenced PDF/material cleanup path and is retryable.
5. A hard operation must identify its exact batch and pass a read-only
   dependency census before mutation. Broad cascades are forbidden.

## Contract matrix

| Entity | Ordinary delete | Historical policy | Hard purge |
|---|---|---|---|
| User | Revoke sessions, suspend and pseudonymize; remove active enrollments | Keep the pseudonymous row so ownership/results do not dangle | Requires explicit transfer/cascade plan; not exposed by the UI |
| Class | Set `deletedAt`; archive active exams; remove enrollments and material/video audience links | Keep the class tombstone for exam history | Admin-only reviewed batch |
| Tag | Set `deletedAt`; archive contained classes/exams | Keep tombstone | Admin-only reviewed batch |
| Exam | Set `deletedAt` (Trash) | Results/Attempts/ExamVersions retained | After retention, remove draft/PDF/live navigation refs and keep an Exam tombstone |
| Result | Not independently deleted | Retained as grading evidence | Only a reviewed privacy/legal workflow |
| Attempt | Not independently deleted | Retained with its bound version/result | Only a reviewed privacy/legal workflow |
| Enrollment | Delete on user/class archive | Not grading evidence | Idempotent |
| Material/Video | Remove archived-class audience refs; retain owned content | Ownership remains on a pseudonymous owner if needed | Separate storage-aware purge |
| Session | Revoke immediately | Security record follows retention policy | TTL/retention worker |
| Private PDF | Detach DB reference first | No public path remains | Fenced durable deletion after commit |

## Operational workflow

The controllers call `services/entityLifecycle.js`; related Mongo writes run
inside `withMongoTransaction`. Production refuses these operations when the
database cannot provide transactions. Single-node Mongo is allowed only in
unit tests whose transaction behavior is separately exercised with
`MongoMemoryReplSet`.

Historical repair is performed only by a journaled CLI with `--dry-run`,
explicit operation and batch, exact compare-and-swap writes, strict
bidirectional verification, resumable failpoints, and reviewed rollback.
