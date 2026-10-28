# Agent Instructions

## Scope

@.claude/instructions/project.md

## Project Approach

Every change moves the code and the features toward the best irreducible abstraction: truthful, compact, efficient, and elegant. Fix the root cause. When a user misreads something, a clearer name or tooltip beats a guard or an adapter. Take the better design however many call sites, tests or rebuilds it touches.

Apply every small refactoring you feel strongly about and fix every clear-cut defect you find, even outside what you were asked to do or planned. For each medium or large change you find or suspect, start a background `general-purpose` agent, not `spawn_task`, whose prompt runs `/agent-refactor` (`.claude/commands/agent-refactor.md`) on the finding and names the files it concerns. Go on with your work. When the agent finishes, tell the owner which plan it wrote, and leave the plan to them.

When the owner asks to rework, refactor or rebrand an area, start fresh. Earlier verdicts, bans and plan decisions on it are history, not constraints: remove them from the plans and docs the rework touches. Keep to the request and to measured facts.

An able agent maintains this codebase, and agents keep improving. Skills, plans, requirements and dev notes state intent and what must stay true, and leave the how to the reader unless only one way is safe. A procedure covers only the cases its writer foresaw, caps its reader at its writer's level, and goes stale with the code.

## Multi-Agent Safety

Several agents may work in this tree at once. Do not wait on them.
Do what your tools can do instead of asking the owner: a stopped agent blocks every agent waiting on it.
You may edit any file, a peer's included, without asking. Never discard work you did not make without the owner's approval: no stash, reset, checkout, clean, restore, revert or delete.
When ownership is unclear, include the file rather than leave a peer's work behind.

Git: one branch, the repository's default, in every environment, whatever branch a session is assigned. Agents share this working tree, so a branch switch moves files under all of them. A session on an assigned branch lands its work on the default branch. Pull, then push, after every commit.

Git worktrees are banned, because a worktree's branch keeps its work out of sight of peers and the owner. `.git/worktrees` is deliberately a regular file, so worktree creation fails at the git level with a bare `ENOTDIR` error. That error is the ban working, not repository corruption. The same file switches on the git guard's refusals and saves, so deleting it to allow worktrees switches them off too.

Messaging teammates (agents not spawned/owned by you) is not allowed. Include their co-owned changes when a rebuild or commit needs them.

## Planning And Review

Plan complex implementation, refactoring, workflow or architecture work before you start it (`writing-plans` skill).

Plans include the refactorings and architecture improvements that move the affected code toward the best irreducible abstraction.

When asking for review, use the `reviewer` agent by name. Repeat the review loop until no agreed `P0` or `P1` findings remain.

When executing the plan, bring it up to date and run the checks the project names at each major atomic checkpoint. From the moment it exists, the plan lists every clone, scratch project or other artifact the work creates outside the tracked tree, with its path and what still needs it. The agent that lands the work deletes each one once nothing needs it, whichever session made it: an artifact made for the work is never the owner's to remove. When work lands, update every plan that names it, peers' plans and other repositories' plans included.

Name a check script by its path from the repository root, so the reader can run it.

### Refactoring Inventory

`Plans/AUDIT-refactoring-opportunities.md` lists the refactoring findings that no plan owns yet, and the plans that own the others. Add a finding there when you can neither fix it nor start an agent to plan it.

## Build And Verify

Run checks cheapest first, each only when the change could alter its result.

Before any final completion claim, record evidence over the content claimed, at the smallest conclusive scope.

A before-and-after comparison needs its before state captured before your first edit and saved in the plan's evidence.

## Writing

Every text has one reader, either a user who skims for the next step or a maintainer with the code open. Give them what they need to act, in their words, and stop.

- User text is everything that ships: documents, the README, the changelog, samples, tooltips, messages and public API docs. It says what the product does and what to do next, never how it works inside. Dev notes live in `Docs/`, which no user receives.
- Write the way you would explain it to a colleague who asked you. Use plain verbs for code, such as is, has, returns, draws and fails. Code is not a person: it does not "stand", "owe" or "wear" anything. Address a user as "you". Do not invent a name for an idea. Do not justify a choice nobody would question. Do not end on a saying. To fix a sentence that does one of these, work out the fact the reader needs and write that. Delete the sentence if you find none.
- A comment, a skill line, a dev note or a memory tells an able reader what the code cannot: intent, what must stay true, a trap, the reason behind code that looks wrong without it. When you cannot tell whether a line is a trap, keep it in plain words: a trap that is cut costs the next reader an hour.
- Each fact has one home: the narrowest place that everyone who needs it will read. For a maintainer, in order of preference, that is the code itself (a name, a constant, a type), a comment beside it, a dev note when the reason spans modules, a skill's references, the skill, and last the project's instructions in `.claude/instructions/`, or `AGENTS.md` for a rule that holds in any project. Memory holds only a general way of working that no repository and no user-level agent instruction has a place for. Requirements, design decisions, one-off requests, verdicts on a single case and plan status never go in memory. A copy of something the code already states (a number, a list, a name, a caller) goes stale.
- A claim about the code is checked against the code when it is written. A false sentence costs more than a missing one.
- Code, comments and documents describe what is, as if written from scratch today. A reader must not be able to infer an edit, a task, a plan or a requirement's history from them, whether from a "no longer", a denial that only a retired design explains, or a list of changes. That history costs every later reader and serves none. Change is recorded in two places: the changelog for a user, and the commit for a maintainer, as `area: what changed` in under 72 characters, then why in plain sentences.
- Deleting comes before rewriting, and rewriting before adding, because a deleted sentence cannot go stale.
- US spelling. Shipped text has no em dash, which users read as a mark of generated text. Where it must name the character, it writes `\u2014`.

@.claude/skills/writing/SKILL.md
