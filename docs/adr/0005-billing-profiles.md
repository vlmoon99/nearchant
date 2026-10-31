# 0005 — Billing on in `operator`, compiled out in `free-local`

**Context.** §4 said local gateways have billing compiled out, but the demo cluster must show billing (flow 2).

**Decision.** Billing depends on the profile, not on where it runs. `operator` (the owner's cluster now, Phala
later) has billing on. `free-local` (anyone running it at home) has billing compiled out at build time, not hidden.

**Consequences.** §4's rule now reads "compiled out in `free-local` builds". Local endpoints still cost 0 in
every profile.
