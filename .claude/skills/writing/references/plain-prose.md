# Plain Prose

Mannered prose is written for how it sounds. The reader has to translate it, and often finds no fact under it. The examples below show the plain voice. Their facts were not checked, so do not copy one into a file.

A writer-side sentence records what the writer knows, decided or went through. A reader-side sentence gives the reader what they need for their next step. Any fact can be written either way. Write it the second way.

## Repairing Mannered Prose

A sentence can need several of these repairs.

| Do | Example | Plain |
| --- | --- | --- |
| Use the ordinary verb, not one that makes the code a person ("stands", "holds", "wears", "owes"). In text for a user, say "you" | "so picking the preset an image falls under is the whole configuration a first export owes" | "Pick the preset that matches your image. A first export needs nothing else." |
| Name the real thing, not an invented noun with "the" | "Whether this Theme seats the moment: the palette, the type, the spacing, ..." | "Apply the theme's colors, fonts and spacing. Turn off to set them from your own stylesheet." |
| Say what happens, without drama | "launders the broken harness into evidence" | "Two empty screenshots are equal, so the check passes on a broken harness." |
| Delete a defense of a choice nobody would change. Keep a reason that stops someone from making a wrong change | "The entry is a constructor argument rather than an optional one, so a rate an entry authored cannot be dropped by an argument a caller forgot" | Delete. The signature says it. |
| Replace a closing line that sounds like a law with the fact | "A paused job is not a dead job." | "A job resumes after its worker restarts. Wait for the restart before calling it dead." |

Split a sentence that joins cause, contrast and consequence.

- Before: "A sync never sets the remote up: a project that has the client and has not configured it is told so beside the toggle and offered the setup as one button there, and a sync before that click saves its output locally and says so."
- After: "If the client is installed but not configured, the window shows a Set Up Remote button. Until you click it, syncs save locally and log a warning."

Keep a project term only when it is the name of something the reader will see: a type, a flag, a folder, a label in the window. Define it where they first meet it.

## Writing For The Reader You Have

| Do | Example | Plain |
| --- | --- | --- |
| Tell a user what the control does to their result, not how it works inside | "At one the volume follows the track's measured loudness, and the limiter reaches as far as the square root of the gain it delivers." | "Playback volume. 1 matches the track's mastered loudness." |
| State the fact, not a puzzle the reader has to solve | "Optional tuning. Unset derives every value such an asset would state." | "Optional. Leave empty for automatic values." |
| In a message, name the asset and say what to do | "'{name}' wears a template stating a layout or basis other than the invoice one, ..." | "'{name}': Invoice Export needs the Invoice template. Skipped." |
| Make each assert message readable alone | One sentence spread over four asserts, so a failure prints "And its placement. Expected: greater than 0" | Each message reads alone: "Parameters.x is 0." |
| Leave tests, guards, lanes, plans and reviews out of documents and comments | "Public so the published key can be pinned against the closed form." | Delete. A test is not a reason for a member to be public. |
| Delete text that only a template asked for | A getting-started guide for a private package | Delete. |

## Saying Less

| Do | Example | Plain |
| --- | --- | --- |
| Replace an essay above the code with what the code cannot say | 874 words of version history above `const int ProbeVersion = 12;` | "Bump when the meaning of an emitted field changes." |
| Keep the reason a design was rejected, and drop the story | "Opening it upward instead ... is a tried and rejected design ..." | "Popovers open below the anchor. Do not flip them upward: a list of every country is taller than the window, so a flipped list covers it." Keep the reason, because it stops someone from proposing the design again. |
| State the rule, not every edge case | "or -1 where the table holds no such position: a row of another sheet, a column outside the table, a cell past its row's count, ..." | "Table index, or -1 if the address is not in this table." |

## Claims That Go False

A claim stays true when the compiler or a test checks it. Nothing checks these, so they go false when the code changes:

- counts ("Four writers" beside five names)
- who calls, writes or publishes a value
- lists that missed a later addition
- UI labels quoted in strings and documents
- names of tests, plans and other files' private members
- measurements, versions and paths ("Pinned: `0.4.0-exp.1`" after the manifest changed → "pinned in the package manifest")
- engine behavior nobody verified
- two texts that describe one thing differently

Do not write them by hand. If the reader needs one, have code fill it in, as a message does with `{names}`.

Cut a claim about this repository that you cannot check. Keep an engine or library trap you cannot check as one plain line with the version it was seen on.
