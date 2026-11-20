# 0001 — Record decisions as ADRs

- **Status:** accepted · {{TODAY}}
- **Context:** Decisions made in chats and terminals get lost, and agents repeat old debates.
- **Decision:** Every real decision gets a short file here, numbered in order, with three
  parts: context (why it came up), decision (what we chose), consequences (what follows).
- **Consequences:** Agents read the ADRs that their task touches. Changing a decision means a
  new ADR that supersedes the old one, never editing history.
