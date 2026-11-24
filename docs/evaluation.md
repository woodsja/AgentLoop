# Independent evaluation

AgentLoop ran the reproducible [query parser fixture](../examples/query-parser) with three cycles available and polish disabled. The [plan](../examples/query-parser/PLAN.md) requested the complete repair in one pass and prohibited artificial cycle boundaries. The [guidelines](../examples/query-parser/GUIDELINES.md) defined ten acceptance criteria.

The committed fixture is the pre-run starting state. The recorded run repaired that working copy, added tests, and updated `STATE.md`.

| Cycle | Worker result | Independent critic result |
| --- | --- | --- |
| 1 | Repaired the parser and added nine passing tests. | `FAIL`: valid percent escapes remained encoded when a field also contained malformed escapes. |
| 2 | Fixed tolerant decoding and added regression coverage. | `PASS`: all criteria were satisfied and 11 tests passed. |

The first worker's own suite passed. A fresh critic tested beyond it, found a real defect, and converted the finding into instructions for the next fresh worker. No package dependencies were added.

## Historical reproduction procedure

The recorded evaluation used the original classic-loop dashboard: its New loop form selected `examples/query-parser`, allowed three cycles, and disabled polish. That admission interface has been retired; these historical settings are not current operating instructions.

For current development work, use the [registered-project and authorized GitHub issue workflow](../README.md#submit-a-development-job) through **New job**, MCP `submit_development_job`, or `POST /api/development/jobs`. A fresh evaluation would require a separately authorized issue in a registered project.
