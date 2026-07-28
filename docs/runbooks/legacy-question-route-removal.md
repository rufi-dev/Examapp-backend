# Legacy question-route removal

The current PDF answer-key and structured builders both save through
`POST /api/quiz/addQuestion/:examId`. The older per-question GET/PATCH/DELETE
surface has no frontend or E2E caller and now returns a measured HTTP 410.

- Metric key: `legacy_question_crud` from `deprecatedRouteMetrics()`.
- Observation window ends: 2026-10-31.
- Before deletion: confirm the counter is zero in production for at least 30
  consecutive days and search access logs for the three route patterns.
- Rollback during the window: restore the former controller registration; no
  data migration is involved.
- The retired controller implementations and exports have already been removed;
  only the measured 410 compatibility routes remain.
- After evidence is reviewed: delete the three 410 route registrations and the
  deprecation middleware in one reviewed change, then run the full builder and
  exam-version suites.
