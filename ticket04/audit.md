# Ticket 04 baseline audit

Baseline: b56ad5876b1ceca4a67ea90f123d4301fd0b094a. Worktree only; no deployment authority.

| Phase | Initiator | Durable writers | Disagreement / required supervision |
| --- | --- | --- | --- |
| Queued/admission | r1-jobs.submit/admit, daemon.fillSlots | store pending task | Exact owner registry, linked-worktree identity and milestone receipt checks precede work. Queue reservation is admission, not delivery authority. |
| Preparing/environment | autopilot.run | autopilot-state.save plus r1 jobStore.save -> checkpoint -> store.writeTask | Every Autopilot checkpoint is copied wholesale to task.r1, phase and bounded phases; stale queue copy can disagree. Environment process claims must survive. |
| Implementation/verification | autopilot + ralph-task-service, internal worker/critic child | Autopilot job, queue copy, independent child task/process claim | Child admission/handoff trusts copied task.r1. Child reservation, PID/start/boot identity, cancellation and complete raw output must remain. Ticket 05 owns child internals. |
| Delivery/CI | autopilot delivery callbacks and repeated run; r1 execute/advance | Autopilot issue file, task.r1/phase; R1 timeout and failDurably | Autopilot recovers delivered SHA before workers. R1 independently chooses timeout/failure and may terminate a resumable checkpoint. Remove this competing decision path. |
| Review/correction | autopilot review history, bounded cycles | Autopilot history + queue copy | Interrupted review must fail closed; exact SHA evidence and full findings survive. |
| Terminal | autopilot markTerminal, R1 finish/conclude/failDurably | Autopilot terminal, queue status/phase/full r1, result evidence | R1 recomputes success with independent evidence predicate; nonautonomous exceptions can archive a nonterminal Autopilot job. Remove recomputation and copied result evidence. |
| Restart | daemon recoverRunningTasks, r1 recover, autopilot issue/target locks and interrupted-state recovery | Queue recovering phase + Autopilot recovery checkpoints | Queue must recover dispatch ownership only; Autopilot governs lifecycle. Unknown/live child identity must prevent replacement and cleanup. |
| Owner inspection | r1 read, generic readJob/result, execution journals | Currently mostly queue copy (canonical reread only for decisions) | Canonical new jobs must read the issue checkpoint; old snapshots stay readable without migration or rewrite. Raw journal stays append-only. |

Agreed test seams (explicitly requested): POST /api/r1/jobs; GET R1 and generic status/results; GET raw logs; POST cancellation; existing durable Autopilot issue state; fresh daemon restart. Existing real-Git/fake external CLI integration fixtures cover these without production access. Full native npm test is reserved for exact-SHA CI, not local execution.

Planned deletion: R1 terminal predicate, failDurably, delivery cleanup/relabel/branch deletion, duplicated phase checkpoint, full job copy and result evidence writes. Retain admission, queue dispatch, child/process supervision and raw evidence forwarding. Use the existing issue JSON representation and locks. Queue metadata may retain only a durable state-directory reference and supervision/identity fields; it cannot become a second lifecycle.

Report placement constraint: requested /home/woodsja/tools/ralph/state/verification-reports/ralph-highlander-20261122/ticket04 is outside writable roots. This worktree copy is the reviewable artifact; no out-of-sandbox write was attempted.
