Create detailed implementation plan(s), or update the plan(s) the user names.

When the user hands you a design to plan, first have a `reviewer` judge it: whether it is an objectively positive change, whether its logic and reasoning are sound, whether the approach is correct, and what would improve it. Apply the findings you agree with.

Then have a `reviewer` verify the design and the plan(s): whether this is the best approach and no better alternative exists, whether the logic and reasoning are sound, and what would improve them. Apply the comments you agree with, update the plan(s), and run the review loop in AGENTS.md to its exit. Delete temporary research artifacts. Use the `user-gates` skill for significant visual changes or decisions. When finished, commit the plan(s) through the `commit-safety` skill: an uncommitted plan reads as still being written, and no agent picks it up.
