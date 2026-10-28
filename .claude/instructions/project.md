@web.md

# konradrzonca.com

## Scope

The account's GitHub Pages user site. Pages builds `main` and publishes `docs/` alone, with its `CNAME` and `.nojekyll`. `docs/CNAME` names konradrzonca.com, so `konrad-rzonca.github.io` redirects there, and the domain forwards to `https://sunforgetools.com`. Without `docs/CNAME`, `konrad-rzonca.github.io` would show the page in `docs/`. A browser check of that page serves `docs/` locally, for example with `uv run python -m http.server -d docs`.

## Boundaries

- Every file under `docs/` is live, and `Docs/` is the same folder on Windows. This repository keeps no dev notes.
- This repository and its commits are public. Nothing in them names a private repository, a machine path or a credential.
- Every commit carries the GitHub no-reply address `24447310+konrad-rzonca@users.noreply.github.com`, which this clone's `user.email` holds. Check it with `git config user.email` before the first commit in a new clone.
