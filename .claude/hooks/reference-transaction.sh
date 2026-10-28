#!/bin/sh
# guard reference-transaction: installed by .claude/hooks/install-git-hooks.ps1
# Git runs this for every ref update, commit-tree and update-ref recipes included, and --no-verify
# does not skip it. A nonzero exit in the prepared state aborts the update. Git holds the ref's lock
# meanwhile, so an update that does not move the shared branch starts no process.
# The shared branch is the one HEAD names, else the one a running rebase returns to, read as
# git-head.js reads them. While HEAD is detached with no rebase, every local branch counts.
# Before the shared branch moves, it runs each .claude/hooks/reference-transaction/*.sh of the
# working tree, in name order, each in its own sh, from the top level of the working tree, with
# "prepared" as its argument and that branch's update lines ("<old> <new> <ref>") on stdin. <old> is
# zeros both when the ref is created and when the caller gave no old value. A check tells the two
# apart by reading the ref, which still holds the tip the update replaces while the check runs.
# Every check runs. A check refuses the update with exit 1, and what it prints on stderr reaches the
# caller. Any other failure lets the update through with a warning, so a broken check never blocks
# every commit.
[ "$1" = prepared ] || exit 0

# Git starts a hook with GIT_DIR set, relative to the hook's folder, only when the call names the
# repository. A .git file points at the git directory, relative to the top level.
gitdir=${GIT_DIR-.git}
if [ -f "$gitdir" ]; then
    { read -r line || :; } < "$gitdir"
    gitdir=${line#gitdir: }
fi
[ -r "$gitdir/HEAD" ] || gitdir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
{ read -r head || :; } < "$gitdir/HEAD"
shared=
case "$head" in
    "ref: refs/heads/"*) shared=${head#ref: } ;;
    *)
        for state in rebase-merge rebase-apply; do
            [ -r "$gitdir/$state/head-name" ] || continue
            { read -r shared || :; } < "$gitdir/$state/head-name"
            break
        done
        # A rebase of a detached HEAD writes "detached HEAD".
        case "$shared" in refs/heads/*) ;; *) shared= ;; esac
        ;;
esac

updates=
moved=
while read -r old new ref; do
    case "$ref" in
        "$shared") ;;
        refs/heads/*) [ -z "$shared" ] || continue ;;
        *) continue ;;
    esac
    [ "$new" != "$old" ] || continue
    case "$new" in *[!0]*) ;; *) continue ;; esac
    updates="$updates$old $new $ref
"
    moved="${moved:+$moved, }$ref to $new"
done
[ -n "$updates" ] || exit 0

# Git starts a hook in the top level of the working tree, unless the call names the repository, by
# --git-dir, --work-tree or their variables, from outside it. Then the hook starts in the caller's
# folder, and the variables hold the paths as typed, which can be relative to another folder. So a
# named repository runs its checks from the folder that holds its .git, with both variables made
# absolute for the checks' own git calls.
if [ -n "${GIT_DIR-}${GIT_WORK_TREE-}" ]; then
    GIT_DIR=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
    case "$GIT_DIR" in
        */.git) top=${GIT_DIR%/.git} ;;
        *) top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0 ;;
    esac
    GIT_WORK_TREE=$top
    export GIT_DIR GIT_WORK_TREE
    cd "$top" || exit 0
fi
status=0
for check in .claude/hooks/reference-transaction/*.sh; do
    [ -f "$check" ] || continue
    printf '%s' "$updates" | sh "$check" prepared
    code=$?
    case "$code" in
        0) ;;
        1) status=1 ;;
        *)
            echo "reference-transaction: warning: $check failed with exit $code, so it did not check the move of $moved. Fix the check, starting from any message above this line." >&2
            gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) &&
                echo "$(date '+%Y-%m-%d %H:%M:%S') exit $code from $check; did not check $moved" >> "$gitdir/hook-errors.log"
            ;;
    esac
done
exit $status
