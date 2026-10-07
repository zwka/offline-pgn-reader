# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Canonical role | Tracker label | Status | Meaning |
|---|---|---|---|
| `needs-triage` | `needs-triage` | Not provisioned | Maintainer needs to evaluate this issue |
| `needs-info` | `question` | Provisioned | Waiting on the reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Provisioned | Fully specified and ready for an agent |
| `ready-for-human` | `ready-for-human` | Not provisioned | Requires human implementation |
| `wontfix` | `wontfix` | Provisioned | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Check the tracker with `gh label list` before applying a label. Provision missing labels with the command in [the issue-tracker instructions](issue-tracker.md). Update this table when the tracker vocabulary changes.
