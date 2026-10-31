# 0003 — One demo story covering all three money flows

**Context.** A solo, part-time build can't deliver every surface in the plan. The owner wants all three money
flows shown and the demo seller to sell a *service* that agents perform.

**Decision.** M0 is judged against one path: Alice sells "Pitch deck in 1 hour — 5 nUSD". Buyer pays → `orders`
holds → agents work, metered to Alice's `billing` balance → one subtask is hired from another agent (A2A + x402)
from a campaign budget → reviewer + `proof-log` → buyer accepts → `orders` releases. See `docs/m0-scope.md`.

**Consequences.** `orders` moves from M2 into M0 with a hold/release mode. Anything not on this path is cut or
deferred (scope cut list in `m0-scope.md`).
