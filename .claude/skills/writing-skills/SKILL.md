---
name: writing-skills
description: You must use it when creating, editing, reviewing or syncing a skill or its references, a command, a rule, an agent definition, a hook, AGENTS.md, or a file under .claude/instructions/
---

# Writing Skills

A skill changes what an able agent does in one area. It holds what an agent cannot find in the code and what would hold on another project: a technology's facts and traps, a method of planning, writing or design, or how the repository's tooling is driven. A product's design decisions live with the design, never in a skill, and a skill names no person.

## Shape

- Source lives in `.claude/skills/<name>/SKILL.md`, with supporting files in `references/` beside it.
- Frontmatter has `name` and `description`. The description is what decides whether the skill loads, so it starts with `You must use it when` and gives trigger conditions only. It names every task, file kind and folder that the body and its references cover, by kind rather than by a script, type or section that a rename would make false.
- The body is a short map and the references have the detail. Nothing appears in both. A skill is read whole each time its area is touched. A line stays only when an able agent would act differently without it. Detail that a reader needs only in some cases goes a level down: into a reference the body names with when to read it, or into the code.
- A command in `.claude/commands/` is prompt text the user adds by typing its name, and it is written like a skill body, under a name short enough to type.
- A rule is one line saying what must stay true, with its reason when the reason is not obvious. A trap is symptom, cause, fix in three sentences or fewer, under a heading a symptom search would find.
- Leave out rosters, call graphs, test descriptions, measurements and incident stories. They are already in the code, the tests and git.
- A judgment call gets a heuristic. An operation with one safe sequence gets the exact command and says it must not be altered.
- Name a capability rather than a tool where that is enough, and use plain relative filenames instead of `@` references, so the skill stays tool-neutral. `AGENTS.md` and the instruction files it imports are the only ones that load others with `@`.
- Agents copy the shape of an example into their output. Give one only where format matters.
- When agents ignore a written rule, its reason was not obvious. State it, and give one positive example before adding a prohibition.

## Shared Files

A skill's files, except `references/project.md`, are copied to every repository that runs the skill, and so are the hooks, rules, commands and scripts the repositories share. Such a file says only what holds in each of them. A line that names a sample, lane, path or product only your repository has goes in your repository's own file: the skill's `references/project.md` for a short refinement, a skill of its own for a topic of its own, a rule of its own with the same `paths` beside a shared path-scoped rule, or a comment beside the code for a trap in one file. A shared `SKILL.md` names its `references/project.md` in one line that says what it holds and when to read it, and that stays true in a repository without the file.

This skill's `references/project.md`, where this repository has it, says which files the repository shares, owns and copies, and how a change to a shared file reaches the other repository. Read it before you change a skill, hook, rule, command, agent or script.

## After Editing

After a hook policy change run `.claude/hooks/test-policy.ps1` (`test-policy.sh` is the same harness for a Bash-only environment).

The guard hooks in `.claude/hooks` run on every shell and agent call of every agent here. A guard hook that is missing, partial or fails lets the call run unchecked, so a half-installed change weakens the guard without refusing anything. The `WorktreeCreate` hook is the exception: it fails the creation on every path. Build a hook change on a copy outside the folder and run `test-policy.ps1` there. Install it by writing each file to a temp file and renaming it into place: new files, then the files they replace, then the settings that name a new entry point. Delete a file only once no settings file names it, and keep a module's export until no hook imports it. The git hooks run `pre-push-save.js` from the working tree. `Monitor` is in `permissions.deny` because in persistent mode it ignores its timeout, and in bounded mode it can expire before the command it watches ends, with nothing to wait on again.
