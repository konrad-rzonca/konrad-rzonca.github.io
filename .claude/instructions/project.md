@web.md

# konradrzonca.com

## Scope

The owner's public page. GitHub Pages builds `main` and publishes `docs/` alone, with its `CNAME` and `.nojekyll`. The domain konradrzonca.com forwards to `https://sunforgetools.com`, so a browser check of the page serves `docs/` locally, for example with `uv run python -m http.server -d docs`.

## Boundaries

- `docs/` is a build made outside this repository. Change the page at its source, or the next publish overwrites the edit.
- Every file under `docs/` is live, and `Docs/` is the same folder on Windows, so keep dev notes outside it.
- This repository and its commits are public. Nothing in them names a private repository, a machine path or a credential.
- Every commit carries the GitHub no-reply address `24447310+konrad-rzonca@users.noreply.github.com`, which this clone's `user.email` holds. Check it with `git config user.email` before the first commit in a new clone.
