---
name: Agent Task
about: Use this template for issues intended for AI assistants like Copilot coding agent
---
name: Agent Task
about: Issue template for tasks intended for AI assistants (Copilot, agents)
title: "[AGENT] "
labels: ["agent", "triage"]
assignees: []
---

## Summary

One-line summary of the task.

## Goal

Describe the expected outcome when this issue is done.

## Acceptance Criteria (required)

Make this list precise and testable — agents complete best with concrete checks.

- [ ] Unit tests added and passing (include how to run)
- [ ] Lint/format checks pass (describe commands)
- [ ] Behavior validated for edge cases (give examples)
- [ ] Changes limited to allowed paths below

> Tip: add example input/output or a small reproducible snippet when applicable.

## Scope & Constraints

- Allowed: `src/`, `lib/`, `tests/`
- Avoid: `infra/`, `configs/`, `scripts/`
- Runtime / compatibility constraints (e.g. Node/Python versions)
- Performance / memory constraints (if relevant)

## Suggested Sub-tasks (optional)

1. Add/modify implementation in `src/`
2. Add unit tests in `tests/`
3. Run linters and fix issues
4. Update docs / changelog

## Clarifying notes for the agent

- If requirements are ambiguous, ask up to 3 clarifying questions before changing code.
- Keep changes minimal and reversible; prefer small commits.

## Related

Links to specs, designs, or reference issues/PRs
