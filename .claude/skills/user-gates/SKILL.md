---
name: user-gates
description: You must use it when planning or executing a visible design choice or an important tuning value that the owner could reasonably make either way, and when writing a plan's User Gate section, building a gate page or recording its verdicts
---

# User Gates

The plan gates every visible design choice on a user pick from rendered options: a User Gate section lists each decision, gated work waits on its verdict, and dependent sub-work is authored only after the verdict. An important tuning value can be a decision too. Gate only a choice the owner could reasonably make either way. A bug fix, which makes the product do what its docs or the owner already say, takes no gate. Nor does a choice with one right answer, such as a high confidence technical improvement: record it in the plan's Design Decisions.

A gate shows the owner what each option looks like, so a decision with nothing to render, such as a cost weighed against a guarantee, gets no page. Record the recommendation in Design Decisions. When the choice sets a product policy that only the owner can set, the User Gate section asks it as a question in text.

## The Page

A gate is a dark web page on disk, handed over as its path and published nowhere. `.claude/scripts/gate-page.py` builds it from a manifest you write beside the renders, and its docstring lists the manifest's keys. A frame is a picture or a video. Render only what the owner needs to judge the difference. Render a still unless the decision is how something moves, and then a video of only the shots that show the motion, a few seconds long: the owner compares options one frame at a time. The page holds the frame the owner picks as they click between options, so render each option's video of a shot over the same moments, frame for frame.

The user reads top down and copies one pick per decision, so everything a decision needs is in one place, one decision after another:
- the question
- a table comparing every option (what it changes, what it costs in time, memory and code, the reasoning behind it, trade offs vs others), brief and easy to understand. When an option leaves a capability unused, its cost says how much code a pick of it could delete.
- one stage with every shot the decision renders
- strong opinions or important details about an option go in as tooltips or recommendations

Render every option of a round in one clone of the repository at one commit, back to back, and check a crop that no option changes for drift. In a tree that others edit, their changes move frames rendered hours apart more than the options do, and a variant built there can reach their commits.

Every existing option renders as a real capture, or a mock over real captures labeled as a mock, the shipped frame among them as a viable option named Shipped. Renders group by option combination where possible, and the stage shows the combination currently picked. The recommended option of each decision is preselected, so every stage opens on a frame and the user changes a pick only where another option is better. A pick is one per decision for the whole page, and the page repeats the picks as text. When one page cannot fit the round's decisions, split it into multiple pages grouped by decision. Include only relevant shots which show the change well.

An option the user already judged, the shipped one included, looks on a new page as it did on the page they judged it on. Before the page goes out, set its frames beside the earlier page's and look: a re-render drifts silently when shared code under it changes, and the user reads the drift as a regression. A changed look is a new option under a new name, shown beside the judged one.

## Verdicts

Record verdicts in the plan by option name, never by position. Present a gate only after its whole round, recommendations included, is reviewed and committed. The next round starts from resolving the verdicts unless the user asks otherwise.
