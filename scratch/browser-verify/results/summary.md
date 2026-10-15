| scenario | before | after | steps b/a | ms b/a |
|---|---|---|---|---|
| D01 form submit succeeds (success message appears) | COMPLETED | COMPLETED/VERIFIED | 3/3 | 414/551 |
| D02 form submit blocked by validation, model claims succ | COMPLETED | TERMINATED:DEVICE_STOP_CONTRADICTED_BY_EVIDENCE:VALIDATION_ERROR | 2/2 | 316/427 |
| D03 server rejects the submit with an error message, mod | COMPLETED | TERMINATED:DEVICE_STOP_CONTRADICTED_BY_EVIDENCE:ERROR_MESSAGE | 2/2 | 306/423 |
| D04 link navigation succeeds | COMPLETED | COMPLETED/VERIFIED | 2/2 | 321/442 |
| D05 click with no visible change, model claims success | COMPLETED | COMPLETED/NOT_VERIFIED | 2/2 | 303/413 |
| D06 the same useless click is proposed again and again | TERMINATED:DEVICE_MAX_STEPS_EXCEEDED | TERMINATED:DEVICE_REPEATED_ACTION_LOOP:CLICK | 20/4 | 1709/760 |
| D07 legitimate repeated clicks (pagination) must NOT be  | COMPLETED | COMPLETED/NOT_VERIFIED | 6/6 | 628/1163 |
| D08 stale locator: the model re-reads the page after a f | TERMINATED:BROWSER_SELECTOR_NOT_FOUND | COMPLETED/NOT_VERIFIED | 1/3 | 232/465 |
| D09 consequential click: approval required, executed exa | COMPLETED | COMPLETED/VERIFIED | 2/2 | 356/459 |
| D10 consequential click whose result cannot be seen | COMPLETED | COMPLETED/NOT_VERIFIED | 2/2 | 352/449 |

TOTAL runs: 30
falseSuccess           before 9 after 0
falseFailure           before 3 after 0
verifiedSuccess        before 0 after 9
claimWithoutEvidence   before 3 after 0
D06 steps spent per run: before 20 after 4
orders D09/D10 (expected 3 each over 3 reps): before 3 3 after 3 3
mean ms of achievable tasks: before 430 after 616 | mean steps 3 3
