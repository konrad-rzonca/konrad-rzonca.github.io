The plan is a standing loop. Each invocation executes exactly one round: the next large coherent set of atomic changes
from the backlog, then stops.

The plan has a prioritized backlog and a Round Ledger (per round: scope, evidence paths, verdicts, commit hash), so
a fresh session resumes from the ledger alone. Archive evidence a rerun would overwrite. Once the plan records the
round's verdicts, the owner's when the round has a gate, delete the round's evidence that no later round or open plan
needs, such as captures, videos, copied output and the gate page. A round's commit contains only the round's changes.

Finish the round with /wrap-up over the round's scoped changes, and commit the ledger update with the round. The plan
file survives every wrap-up: the loop ends only on the user's explicit verdict, and only then is the plan deleted.
