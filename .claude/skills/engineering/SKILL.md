---
name: engineering
description: You must use it when writing, reviewing or refactoring code in any language, its comments and names included, or exploring the code and its structure
---

# Engineering

The standard for code in this repository. `references/project.md`, where this repository has it, says where the design lives, which module may reference which and where a new file goes, and adds this repository's comment and naming rules. Read it before you add a file, a dependency or a comment.

## Comments And Docs

- A comment says what the code cannot: a constraint, a unit or space, an engine trap, another symbol that must change together with this one, the reason behind code that looks wrong without it. It takes one or two lines beside the code it concerns, and a channel layout or an encoding takes the lines it needs. A rename, an extraction or an explanatory variable comes first.
- Public API has a doc comment that says what the member is for in one sentence, then how it fails if it can.
- The story of a bug, measurements, rejected alternatives and the reasoning behind a design belong to the commit body. A comment keeps only the reason that stops a wrong change to the code beside it. A design reason that spans modules, with what it rejected, belongs to the design documents.
- A comment describes the code as it stands, never what it used to do or what changed. Source has no commented-out code (git keeps it), no regions or section dividers (a file that needs them needs splitting), and no plan names, round tags, dates or agent names.

## Names

- A name says what the code does and what the data means.
- Of two names that read equally well, use the shorter. A name leaves out what its declaring type and its signature already say.
- A name or a path that a script, a string or recorded history refers to is an interface. Search for it as a string before you rename or move it.
