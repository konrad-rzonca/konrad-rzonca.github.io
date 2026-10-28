---
name: writing-plans
description: You must use it when creating or reworking multi-step implementation plans
---

# Writing Plans

Plans transfer understanding: user intent, verified research, stable constraints, decisions implementors must not rediscover, and verification evidence expected before completion. They are context-rich but declarative, not edit recipes.

Save plans to `Plans/PLAN-<name>.md`. Temporary research notes may exist only while active and must be deleted before plan completion.

`references/project.md`, where this repository has it, adds what this repository's plans must hold for its own kinds of work. Read it before you write a plan.

## Core Contract

- Capture problem, requirements, design intent, domain context, constraints, verification, all decisions, and documentation follow-up.
- Research current code, docs, tests, and relevant external constraints before finalizing. An unverified plan is worse than no plan.
- Record decision-critical facts: rationales, stable signatures, filters, formulas, fields, public boundaries, gotchas, reference implementations by path plus pattern, test values, and rejected options.
- Requirements state observable outcomes and invariants. Prefer "what must remain true" over "which file to edit."
- Include the user's instructions in their own words, cleaned up: fix grammar, typos and speech-to-text slips, and cut repetition, but keep every request, name, number and nuance. The user often dictates and does not reread, so a raw transcript costs every later reader.
- Non-trivial plans require design decisions with rationale and rejected alternatives. Design intent supplements decisions, never replaces them.
- Domain context records durable facts code cannot convey: user intent, cross-system contracts, non-obvious behavior, formulas, stable public boundaries, and constraints.
- File paths, API names, signatures, and reference implementations are allowed as stable contracts or orientation. Do not include copy-paste code, command transcripts, line-numbered recipes, exhaustive inventories, or step-by-step implementation checklists unless the user explicitly owns that boundary.
- Identify up front each document the work makes stale or adds, and assign its update to a phase. An assignment gives the property or the user-visible outcome the text must state. Wording that a plan gives for a document, a tooltip or a skill is a draft, and the executor restates it in the `AGENTS.md` Writing voice.
- If a plan becomes stale, update the intent and current constraints first. Delete obsolete implementation directions instead of patching around them. Update the owning plan when implementation changes the design, and never open a second progress tracker for the same work.
- If intent, ownership, behavior, or a design trade-off remains unclear after research, stop and ask before finalizing the plan.
- A plan lists the dev tools it adds for its own evidence, and closing it deletes each one nothing else uses.
- Weigh the perspectives of the people the work serves and the disciplines it touches in requirements and design decisions.
- Documentation and skill changes carry their exact final wording when it is known, otherwise the intent and its writing constraints. A plan sets no word budget for a document.
- A plan is written for its executor in the plain `AGENTS.md` Writing voice, because its sentences get pasted into documents. Its record of decisions and rejected options is its purpose, not history to remove.

## Shape

Use this structure unless the task is genuinely trivial:

- Status, first: planning, ready, or what is in progress and what is next.
- Goal
- Problem Statement
- Requirements
- Research Performed
- Design Decisions
- Design Intent, when useful
- Constraints
- Verification Expectations
- Documentation And Skill Follow-Up, only when user-visible behavior or a requirement changes or the work is expected to leave a trap

For complex work, the master plan owns requirements, context, and decisions. Phase or sub-plans reference it and add only dependencies, risks, exit criteria, and phase-specific context needed for independent execution, each executable with only the master and itself loaded. Split only when one implementor could not hold the whole plan plus its touched domain at quality, or when a mid-plan user decision gate makes downstream detail speculative. Author post-gate sub-plans after the verdicts land, not before. Never split for parallelism: streams of one master co-depend, and sub-plans execute one at a time even when they look independent. A sub-plan that restates master content or needs its siblings loaded bought nothing, so merge it back.

## Ready

Before presenting the plan as ready, run the required `reviewer` pass. Commit the plan through the `commit-safety` skill. Execution follows with no approval step: only a decision in a User Gate section (`user-gates` skill) waits for the user. Its verdict is the acceptance, so no phase or handoff waits for the owner to review what landed.
