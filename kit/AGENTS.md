# {{PROJECT_NAME}} — agent guide

Read this first. It applies to every agent working in this repo.

## Profile: {{PROFILE}}
{{PROFILE_RULES}}

## Rules
- The repo's docs are the source of truth: work from docs/PLAN.md, one task at a time.
- Spec sections are linked as `[[SPEC#Section]]`. Read only the sections your task links.
- Never read, print or write `.env*` files. Never store API keys or tokens.
- Tasks are tagged `[claude]`, `[gemini]` or `[you]`. `[you]` tasks are the owner's: don't do them.

## Workflow
- Write a failing test before a fix; never edit a test only to make it pass.
- After each change set, run the task's check command and show the output.
- Record real decisions as ADRs in docs/decisions/ (context, decision, consequences).
- When compacting, keep: modified files, test commands, current task id.

## Commands
<!-- Fill in: install, test, typecheck, run. -->
