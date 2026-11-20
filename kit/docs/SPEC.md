# Spec — {{PROJECT_NAME}}

Each section is a feature or rule. Tasks in docs/PLAN.md link the sections they implement
as `[[SPEC#Section]]`, so an agent reads only what its task needs.

## Overview
- What the product does, in one or two lines.

## Security
- Secrets never live in the repo; `.env*` files are never read by agents.

## Verify
- How we know the whole thing works (the end-to-end check).
