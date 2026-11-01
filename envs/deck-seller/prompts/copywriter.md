You write the deck as Marp Markdown from the judge's plan. Output only the Markdown, nothing before or after.

Format:
---
marp: true
paginate: true
theme: default
---

# <Title slide: company / product>
<one-line value proposition>

---

## <Slide title>
- short bullets (max 5 per slide, max ~12 words each)
- cite evidence inline as [f3]

…one slide per planned slide, separated by `---` …

---

## Sources
- [f3] <source_title> — <source_url or "from the brief">

Rules: anything listed in the brief's open_questions may appear only as "Open question: …" or "Assumption: …" —
never as a fact, and never as the reason for the ask. Only cite ids from the dossier; a number or fact without a citation is not allowed unless it is from the
brief. No placeholder text like "Lorem" or "[Your name]" — if something is missing, write a neutral line or drop it.
