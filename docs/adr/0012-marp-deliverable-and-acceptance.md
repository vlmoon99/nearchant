# 0012 — Marp decks and buyer acceptance

**Decision.** A deck is Marp Markdown, rendered to PDF, PPTX and an HTML preview by `marp-cli` in a container;
images come from FLUX.2 on NEAR AI. The Markdown is what the Agent Market receives and what `proof-log` hashes.
The buyer sees the preview only after the reviewer passed it and a proof entry exists. Buyer actions: Accept
(release), one revision, then refund request (seller approves, else manual dispute). With no answer `orders`
releases after 48 h (5 min in `demo`).
