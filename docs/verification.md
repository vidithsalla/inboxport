# Verification evidence

Last verified: August 2, 2026.

The private implementation was checked in its current uncommitted launch state
after comparing it with the earlier independent review commit.

## Automated results

| Check | Result |
|---|---|
| Unit and security tests | 227 passed, 0 failed |
| ESLint | Passed |
| Standalone TypeScript check | Passed |
| Production Next.js build | Passed |
| Git whitespace validation | Passed |

## Covered behaviors

Representative automated coverage includes:

- User, account, and installation isolation
- Zero-grant installation creation
- Per-account permission enforcement
- Immediate denial after installation or grant revocation
- Account pause before provider access
- Gmail and Outlook search, message, and thread dispatch
- Gmail and Outlook draft creation and updates
- Search-only snippet removal
- Content-free audit persistence guards
- Encrypted account credential storage
- Approval expiry and atomic state transitions
- Gmail and Outlook changed-draft rejection
- Attachment rejection for approval-gated sends
- Definitive versus ambiguous provider-send outcomes
- No automatic retry after an ambiguous send
- Cross-approval ciphertext swap rejection
- Header-injection validation
- Same-origin checks for state-changing routes

## What the numbers do not prove

Passing automated tests does not establish that InboxPort is production-ready
or independently secure. The current evidence relies heavily on controlled
provider fakes. Live testing has been limited, Google restricted-scope approval
has not been completed for a public launch, and the prototype has not received
an independent security assessment.

The public repository intentionally reports both the passing checks and these
limits so that test count is not mistaken for external validation.

