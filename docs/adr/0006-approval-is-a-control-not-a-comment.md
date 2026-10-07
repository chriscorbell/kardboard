---
status: superseded by ADR 0011 on 2026-10-07
date: 2026-09-13
---
# Approval is a recorded control action, never an interpreted Comment

Merging to main is the one irreversible outcome a Session produces. Letting a Session decide that a Comment such as "looks good, but the footer is off" is or is not approval would put the least reliable component in front of the least reversible action. Approval is therefore an explicit Approve control on a Card in Review, recorded as its own event and available to any Member of the Board. A Session may reply to a Comment that reads like sign-off by asking the Member to press Approve, but it never merges without a recorded Approval. On Approval the Session rebases the branch if main has moved, re-runs checks, squash-merges, deletes the branch, and moves the Card to Done.
