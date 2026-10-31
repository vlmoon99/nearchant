# 0007 — Spark primary, Phala hot standby, manual failover

**Decision.** The gateway, workers, Postgres primary and a `cloudflared` connector run on a Spark. A Phala CVM
joins the tailnet and runs a Postgres streaming replica, a standby gateway and a second `cloudflared` connector for
the same tunnel. `make failover` promotes Phala by hand (Patroni-style automatic failover is M1). Around 12 Nov
Phala becomes the permanent primary for judging.

**Consequences.** Money state lives on chain, so a lost database loses only in-flight swarm tasks. Calls from Phala
to Spark models over the tailnet are `local` tier, not attested; the README says so.
