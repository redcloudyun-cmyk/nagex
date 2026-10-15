| scenario | before | after | before errors | ms b/a | calls b/a |
|---|---|---|---|---|---|
| W01 control: plain button in the page | 3/3 | 3/3 | - | 356/370 | 3/3 |
| W02 button inside an open Shadow DOM | 0/3 | 3/3 | AGENT_NO_TARGET | 134/308 | 1/3 |
| W03 input + button inside nested open Shadow DOM (2 levels) | 0/3 | 3/3 | AGENT_NO_TARGET | 127/339 | 1/5 |
| W04 input + button inside a same-origin iframe | 0/3 | 3/3 | AGENT_NO_TARGET | 124/393 | 1/5 |
| W05 button inside an iframe inside an iframe (depth 2) | 0/3 | 3/3 | AGENT_NO_TARGET | 125/391 | 1/3 |
| W06 cross-origin iframe: the runtime must STATE the limit | 0/3 | 3/3 | - | 122/124 | 1/1 |
| W07 two "Open" buttons, one in a Shadow DOM card: pick Card B  | 0/3 | 3/3 | BROWSER_SELECTOR_AMBIGUOUS | 159/304 | 2/3 |
| W08 the one matching button after 3000 other controls | 0/3 | 3/3 | AGENT_NO_TARGET | 834/549 | 1/3 |
| **TOTAL** | **3/24** | **24/24** | | | |
