---
name: commit-safety
description: You must use it when about to make your first edit in this shared tree, and when staging, committing, writing a commit message, undoing or repairing git state, or working in a file a peer has changed
---

# Commit Safety

Several agents write this working tree at once and share one git index and the branch `HEAD` is on. Moving `HEAD` moves the files under every agent, and their next commits land wherever it went. Commit only the content you wrote, through a private index. `references/temp-index-recipe.md` has a script that keeps every rule below, and what each of its guards stops. `references/project.md`, where this repository has it, lists the commit areas, the state this repository commits or leaves out, and the check of a commit before the branch moves. A file there named for a technology stack holds that stack's commit traps. Before your first commit here, read every file in `references/` except one for a stack this repository does not use.

## Before The First Edit

- Write down the paths you will change, each with the blob it has now, and never regenerate that list from the working tree (recipe, "Record the base before the first edit").
- A file a peer has already dirtied is co-owned. Edit it without asking or waiting, and never clean or revert the peer's part. Save the peer's diff first (`git diff HEAD -- <file>`), because afterwards the file does not show whose line is whose.

## The Commit

- Choose the commit set yourself, without asking the owner: every file you changed, co-owned ones included.
- Never run a bare `git commit`. It writes the whole shared index, a peer's staging included. Never amend either: by the time you do, `HEAD` may be a peer's commit.
- Never commit by pathspec. It takes the working tree under those paths, a co-owner's uncommitted hunks included, and over a folder it skips untracked files without a message. A check over the working tree still passes, because it reads the working tree and not `HEAD`. Stage untracked files in your set by name.
- For a co-owned file, commit `HEAD` plus your hunks, never the working file whole. The peer's hunks stay in the working tree for the peer to commit. A check over the working tree does not test that blob, because it reads working files. The recipe says how to build it and how to check it.
- When your change cannot be separated from the peer's, because you rewrote the file or you both changed the same lines, commit the file whole and say in the commit body that it includes a peer's uncommitted work, and which part. `AGENTS.md` prefers including a peer's work to leaving it behind.
- If `HEAD:<path>` moved, a peer committed inside your file, and your working file staged whole can revert their commit while every guard passes. Merge your change onto the new `HEAD` blob (recipe, "Stage a moved path by merging").
- Build the commit in a private index and move the branch with a compare-and-swap `git update-ref`, which fails when a peer committed first.
- The commit is not finished until you reset your paths in the shared index (recipe, "Close the shared-index trap"). Until then the index is a staged revert of your commit, and a peer's bare commit would commit it.

## Undo And Repair

- Undo nothing you did not write: no stash, reset, checkout, clean, restore or revert over content a peer wrote, staged or committed. Revert a file only when it is byte-identical to your last write. A peer's staged blob stays staged even when it adds nothing to `HEAD`, because staging it was their decision.
- Repair forward. When a commit overwrote a peer's work, add a commit on the current head that restores each overwritten path to the blob the peer's commit wrote. Never rewrite a branch a peer has built on.
- Before a git command discards a working file, a staged blob, a branch or a stash entry here, the guard hook saves it under `refs/guard/<time>-<pid>/`, and its notice names the ref and the command that takes each kind back. Before a push rewrites or deletes `origin`'s copy of the branch you work on, the git `pre-push` hook, where this repository installs one, saves the old tip the same way. `git for-each-ref refs/guard` lists the saves, and each notice says when they are deleted. Ignored files are never saved.
- Do not skip git hooks here: `--no-verify` skips the `pre-push` hook that saves `origin`'s branch before a push rewrites it, and `-c core.hooksPath=` skips that one too.
- "Unable to create '<ref>.lock': File exists" means another git process holds that ref, often while a hook runs for it, and on Windows "Permission denied" on a ref usually means another git process was writing it at that moment. Run the command again once, and if it fails again, check the file's permissions. Never delete the lock file while a git process may be running: two writers to one branch can drop a commit without either failing.

## The Message

The `AGENTS.md` Writing section gives the shape. The area is tests, tools, docs, plans, an area `references/project.md` lists, or a new word when none fits. One change per commit. The body is as long as the reason needs. A measurement, a rejected alternative or a bug's cause goes there rather than into a comment. The exception is a figure or a reason that stops someone from wrongly changing the code beside it, which stays in the comment. Run ids, counts and plan phases stay out of the sentences. A check's result goes on one line after the body, `Verified: <check> <passed>/<total>`, where one search finds every commit's evidence.
