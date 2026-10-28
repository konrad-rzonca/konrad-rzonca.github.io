The plan adds a critic pass beside each reviewer pass, judging the implemented result on rendered evidence
alone. Completion requires a clean critic verdict on the final evidence.

- Fresh critic per round, attuned to the plan's domain and its quality bar. It names what works, then ranked findings:
  confusion, readability, layout, composition, artifacts.
- Renders only: screenshots, captures, video or motion strips. No repo text, code, diffs, plan content, or implementor
  rationale. Comparison pairs carry no provenance. Name the surface to judge, never the change. A fix stays only when
  the critic prefers it, in such a pair, to the version before it.
- When UI/UX is in scope the critic explains how every visible control works, each explanation with a confidence
  rating. A control it cannot explain, or explains wrongly at high confidence, is a finding.
- Probe every finding with a checkable referent before changing anything. A state shown only by hover or a transient
  needs a capture before its finding counts. Findings on settled owner decisions go to the user as options.
- Critic transcripts are temporary notes, deleted before completion.
