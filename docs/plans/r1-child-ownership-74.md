# #74 implementation plan (written before code)

## Problem reproduced
R1 currently generates top-level PLAN tasks from every issue acceptance item. Issue woodsja/finance-dashboard#75 combines code/test requirements and R1-owned PR/CI/final-review requirements. The existing critic prompt requires every PLAN item before PASS, so child consumes its cycle budget trying to perform parent delivery operations. This was observed in the live pilot.

## Design: one authoritative implementation obligation
`syntheticPlan` compiles an *implementation-only* child plan with one indivisible, model-verifiable task: implement the source/test changes requested by the issue and run relevant local checks. Preserve the original issue text and acceptance as explicitly **untrusted contextual data** (blockquote lines, never top-level PLAN task syntax). The GUIDELINES tell worker and critic that the parent solely owns git commits, PRs, CI, final PR review, merge. Child must not require or attempt them. The authoritative R1 parent still applies every existing deterministic and external gate after final child PASS. No keyword-based parsing, no new scheduler, no redefinition of issue requirements for delivery. Keep both valid named requirements and delivery details visible as context.

## Acceptance
- Test original Finance #75 body and acceptance; `parsePlanTasks` finds exactly the implementation+local-check task, never delivery tasks.
- PLAN and GUIDELINES present immutable responsibility split; issue prose cannot inject extra top-level PLAN items even if it contains checklist and headings.
- Existing child critic PASS strictness and R1 deterministic verifier/callback preserved; tests prove negative verdict never invokes verifier.
- Test a fully mocked parent->child PASS->deterministic verify path with full mixed issue, plus legacy/default R1 regression.
- Focused tests, full suite, CI and independent restricted Opus review before merge; live code/config untouched.

## Deferred to other tickets
#75 durable safe recovery artifacts; #76 full-stack live Finance retry. Do not expand scope to child cycle budgets or dependency setup.
