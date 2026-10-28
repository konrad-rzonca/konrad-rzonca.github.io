# The Private-Index Commit

This commit contains exactly the blobs you chose, while peers stage and commit through the shared index. The script below is one way to make it. Any way you make it keeps these true:

- The commit is built on `OLD`, the parent read once, in a private index.
- The staged name set equals the set you declared.
- Every staged hunk is one you reviewed, and no staged file lost lines you did not remove.
- The branch moves by a compare-and-swap `git update-ref`.
- Your paths are reset in the shared index afterwards.

## Record the base before the first edit

Hash each path you will change with `git hash-object -w --path <repo path> -- <file>`, never `--no-filters`, which gives a CRLF working file a different id from its LF blob. Only the filtered id compares with `git rev-parse HEAD:<path>`. `-w` also stores the blob, so a merge onto a moved `HEAD` can read the declared base back with `git cat-file blob <hash>` (Stage a moved path by merging).

For many files, `git hash-object -w --stdin-paths` run from the repository root, with repo-relative paths written as UTF-8 without a byte order mark, gives the same ids in one call. It stops at the first file it cannot open, so check that it printed one line per path.

## Build, guard and commit in one script

Staging, the guards and the commit run in one shell call. A guard run in a separate tool call leaves a gap in which a peer can commit.

```bash
printf '%s\n' <your paths> > <paths file>   # the declared set, before anything is staged
export GIT_INDEX_FILE="$SCRATCH/commit.index"
OLD=$(git rev-parse HEAD)                # the parent, read once: a peer can commit at any moment
BRANCH=refs/heads/$(git symbolic-ref --short HEAD) || exit 1   # fails while HEAD is detached
git read-tree "$OLD"                     # start from the parent, not from the shared index
git add -- <your paths>                  # whole files you own outright
# mixed files: pipe `git diff "$OLD" -Un -- <file>` through a hunk picker, then `git apply --cached`
# guards, each aborting before the commit:
#   staged name set equals the paths file exactly
#   the staged diff carries none of the concurrent markers you listed
#   every staged path's diff against the parent is the one you reviewed: a peer can write inside your
#   file between your last read and this staging, so record each path's `git diff --numstat "$OLD"`
#   when you review it, and compare the staged numstat here
#   no staged file lost lines you did not remove: a peer's script can truncate a file before it
#   writes it, and a read in that moment stages the empty file past every other guard, so read
#   `git diff --cached --numstat "$OLD"` for a deletion you did not make
#   no staged addition is ignored: `update-index --cacheinfo` and `add -f` bypass .gitignore, so
#   `git diff --cached --no-renames --name-only --diff-filter=d "$OLD" | git check-ignore --no-index --stdin` prints nothing
#   when you built a candidate, each staged blob is the candidate's (`git ls-tree <candidate> -- <path>`),
#   or for a path HEAD moved since, the candidate's change merged onto the new blob (Stage a moved path by merging)
TREE=$(git write-tree)
NEW=$(git commit-tree "$TREE" -p "$OLD" -F <message file>)
git update-ref -m "commit: private index" "$BRANCH" "$NEW" "$OLD"   # fails if a peer moved the branch
```

`git update-ref` with both the new and the old value is a compare-and-swap. If a peer commits between `rev-parse` and `update-ref`, it fails, and their commit is not overwritten.

A concurrent marker is a string found only in a peer's hunks of a co-owned file, such as a symbol the peer added. List them when you save the peer's diff.

## A hunk picker commits a whole file as deleted or empty

`git diff <commit> -- <path>` compares against the working tree through the index, and with `GIT_INDEX_FILE` naming a missing or empty index it reports every line of the file as removed. Run the picker after `git read-tree`, or before the export, never between them. Test each guard's exit and stop on a failure: a guard that only prints its mismatch lets the commit go ahead.

## A commit built from a clone's file list holds no change

An exported `GIT_INDEX_FILE` also reaches git calls in another checkout, and `git status` in a clone read through it listed none of the clone's changes. The commit then held no change and passed a guard that compared the declared set with the staged set, because both were empty. Run git in another checkout with `env -u GIT_INDEX_FILE`, and stop when the declared set is empty.

## The staged name set is short by the number of deletions

Git pairs a deletion with an unrelated addition when the two are similar enough, such as two files of mostly boilerplate, and reports them as one rename under the new name, so the deletion never appears. Compare name sets with `git diff --cached --no-renames --name-only`, and use the same flag on a marker search over the staged diff.

## `git apply` rejects a hunk picker's patch that looks correct

A filter that reads text streams on Windows rewrites LF to CRLF. Read and write binary streams and split on `b"\n"`. Check first that the unfiltered patch applies with `git apply --cached --check`, so that a later failure is known to be the filter's.

## Kept lines end up in the wrong place after hunks were dropped

Do not give a patch with dropped hunks to `git apply --unidiff-zero`. A hunk with no context is placed at its new-side line number, which every dropped hunk above it has shifted, and git does not check the position. Apply the kept hunks yourself onto `git show HEAD:<path>` at the diff's old-side positions, last position first. Take the diff against `HEAD`, not the index, because a peer's staging shifts every old-side number. A `-U0` hunk can contain two authors' insertions at one anchor. Split it by line.

## A function is half old and half new after hunk picking

A rewritten function shares anchor lines with its old form, so its diff splits into several hunks, and the ones without your markers classify as the peer's. Use hunks to find where the two versions interleave, then move whole regions.

## Edits you can replay need no hunk picker

Apply your scripted replacements to `git show HEAD:<path>`. The result is `HEAD` plus your hunks. Write it with `git hash-object -w --path <repo path>` and put it in the private index with `git update-index --cacheinfo`. A working file that differs from the result has a peer's hunk, which stays in the working tree for the peer to commit.

## Check the tree you commit before the branch moves

A check over the working tree runs the hunks you left out and every peer's edit, so a green one says nothing about the tree a hunk-split commit carries. Read each kept hunk for a symbol that only a left-out hunk declares, and each left-out hunk for a symbol a kept hunk removes. A match means you classified a hunk wrongly.

To check the commit itself, build the same commit without moving the branch, by the script's steps up to `git commit-tree`, and run the check over that candidate. The skill's `references/project.md`, where this repository has it, names that check and says when a commit needs it. Then run the one-call script with the candidate's blobs. If a peer moved the branch meanwhile, the script builds on the new `HEAD`: do not run the check again.

If the check cannot find a symbol that the working tree has, you classified a hunk wrongly, or the symbol is in a linked repository's uncommitted edit, which a check over a commit never reads.

## Stage a moved path by merging

A peer can commit inside a path you declared while your working file is still your edit over the old base. Hashing that working file into the private index reverts their hunk, and every guard passes, because the path was declared and the name set matches.

Merge your change, from the declared base to the working file, onto the `HEAD` blob:

```bash
git merge-file -p <head blob copy> <declared base copy> <worktree copy>   # ours, base, theirs
```

Write the three copies with one line ending. Blobs are LF and a working file can be CRLF, and a mixed set merges as every line replaced. Hash the result with `git hash-object -w --path <repo path>`, so that the conversion applies on the way back in.

`merge-file -p` prints the merged file even when it conflicts, with the conflict markers in it, and returns the number of conflicts as its exit code. Stop on a nonzero exit: a blob hashed from that output commits the markers, and a script that pipes the output on never sees the conflict. A conflict means both edits touch the same lines. Read the file and resolve it as its owner would. Never force one side. If your own earlier commit wrote the blob `HEAD` has now, there is nothing to merge.

After the commit, whatever the working file has beyond your blob is the peer's uncommitted work. Leave it.

## Close the shared-index trap

A `GIT_INDEX_FILE` commit never touches `.git/index`, so each committed path still has its pre-commit blob there. Against the new `HEAD` that is a staged revert, and a peer's bare `git commit` would commit it.

```bash
git reset -q --pathspec-from-file=<paths file> --   # index only, worktree untouched
git status --porcelain -z -uall --no-renames        # read whole, then join with the paths file
```

Join the status with your declared set by name:

- A declared path whose index column is neither a space nor `?` is residue.
- A declared path at `??` is a file your commit deleted that is still in the working tree.
- ` M` on a blob you built as `HEAD` plus your hunks is the peer's hunk, which belongs there.
- If `git status` fails, abort. A failure is not an empty result.

Read the status once and whole. `git status` has no `--pathspec-from-file`, a few thousand paths overflow the argument list, and word-splitting the paths file breaks a path with a space. `-z` gives unquoted paths and `--no-renames` gives one path per record.

Reset a hunk-split file by name if the paths file does not list it. Its index entry must equal `HEAD` while the working file keeps the peer's hunk.

Variants, by the two-letter status code:

| Code | What it is | What it needs |
| --- | --- | --- |
| `MM` | Stale leftover on a tracked file | The reset above |
| `D ` plus `??` | The path was untracked at commit time, so the index stages its removal | The same reset, or `git update-index --add` |
| `AM` after a `--force-remove` | The index entry went, the worktree file stayed | Remove the worktree file too |

### An empty paths file resets the whole shared index

The paths file is your declared set, written before the commit. A list made afterwards from the private index's `git diff --cached` is empty, because that index already matches the new commit. `git reset --pathspec-from-file` over an empty file is a full mixed reset: it unstages the whole shared index and exits 0. No content is lost, but a peer's staging is withdrawn without either of you seeing it. Read the path count back before the reset. If the paths file is lost, the commit itself lists the set: `git diff-tree --no-commit-id -r --no-renames --name-only <commit>`.

### The index blob is a peer's staged work

Do not reset a path whose index blob already contains the text you just committed. The peer staged the file after your edit, and a reset unstages their work. Confirm that `HEAD`, the index and the working file all contain your committed text, and leave the index as it is.
