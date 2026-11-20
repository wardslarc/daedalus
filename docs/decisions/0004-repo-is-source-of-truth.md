# 0004 — The repo is the source of truth

- **Status:** accepted · 2026-11-20
- **Context:** Specs, plans and decisions must survive without Daedalus and stay editable by hand.
- **Decision:** INTAKE, SPEC, PLAN, decisions and reviews are markdown files in each project's repo. SQLite only caches and indexes them; Daedalus writes changes back to the files.
- **Consequences:** `docs/` doubles as an Obsidian vault. File watching (chokidar) keeps the index current.
