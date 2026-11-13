# Verification evidence

Last verified: November 13, 2026.

These results were recorded against the reviewed source snapshot imported into
this repository.

## Automated results

| Check | Result |
|---|---|
| Unit and security tests | 229 passed, 0 failed |
| ESLint | Passed with 0 warnings |
| Standalone TypeScript check | Passed |
| Production Next.js build | Passed with Next.js 16.4.6 using webpack |
| Git whitespace validation | Passed |
| npm audit, root and video project | 0 known vulnerabilities |
| OSV-Scanner, both lockfiles | 0 known vulnerabilities |
| Semgrep full private-tree security/OWASP/secrets rules | 0 findings across 167 tracked files |
| Semgrep exact staged public snapshot | 0 findings across 109 scanned code/config files |
| Gitleaks publication-tree scan | 0 findings |
| Gitleaks private-history scan | 0 findings across 45 commits |
| Gitleaks existing public-history scan | 0 findings across 5 commits |

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
- Loopback-only enforcement for authentication-bypassing demo mode
- Feedback relay rejection of redirects and credential-bearing URLs
- Constant-time cron-secret comparison

## What the numbers do not prove

Passing automated tests does not establish that InboxPort is production-ready
or independently secure. The current evidence relies heavily on controlled
provider fakes. Live testing has been limited, Google restricted-scope approval
has not been completed for a public launch, and the prototype has not received
an independent security assessment.

The repository intentionally reports both the passing checks and these limits
so that test and scanner counts are not mistaken for external validation. See
the [publication security review](security-review-2026-11-13.md) for scan scope
and remediations.
