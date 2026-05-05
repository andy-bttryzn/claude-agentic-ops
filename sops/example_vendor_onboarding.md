---
name: Vendor onboarding template (Webleads)
description: Canonical 6-step onboarding flow for new buyers signing up for the Webleads modality. Used by the agent to detect missing onboarding tasks on a vendor record and surface them as Open Items.
type: reference
---

# Onboarding template: Webleads buyer

When a new vendor enters the Onboarding stage with the Webleads modality tag, the following tasks must exist on the work board, linked to the vendor record:

1. **Sign Contract**: MSA + IO from the buyer side. Status flips to Done when both signers complete.
2. **Setup Delivery Endpoint**: buyer-side post URL configured in the lead-distribution platform.
3. **Setup Buyer Tags**: match-class tags (B:0 / B:1 / B:3) applied at buyer-record level for tag-based routing.
4. **Setup Accounting / Billing Terms**: buyer's invoice email + payment terms (Net 30 default) recorded.
5. **Define Return SLA / Method**: agreement on disposition return window + return submission method.
6. **Approve Landing Pages**: buyer-side approval of the landing pages we'll route their leads through.

## Agent behavior

When an Onboarding-stage vendor is missing any of these tasks, the agent should:

- Add a Section 9 (Open Items) entry per missing step
- Add a Recommended Action to spawn the missing task
- NOT auto-create the task (Andy decides)

When ALL six exist with Status = Done and the vendor's group flips to Live, the agent should:

- Move all six tasks to the Completed Projects group
- Note the launch date in the vendor record's Notes column
