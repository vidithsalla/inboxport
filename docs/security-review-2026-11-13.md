# Publication security review

Review date: November 13, 2026.

This review was performed before importing the application source into the
public InboxPort repository. It was intended to reduce avoidable publication
risk, not to certify InboxPort as production-ready.

## Scope

- The complete private source tree at the reviewed commit
- All 45 commits and 531 historical Git blobs in the private repository
- The existing five-commit public repository history
- Ignored local environment files, inspected without printing their values
- The root application and nested Remotion project's dependency graphs
- Authentication, OAuth, webhook, tenant-isolation, approval, credential,
  logging, and provider-adapter boundaries
- The exact clean source snapshot prepared for public import

The public import deliberately excludes the private Git history, ignored
environment files, internal agent/tooling files, internal setup notes, build
artifacts, dependency directories, and video-production source.

## Findings remediated before publication

1. Updated Next.js, the MCP SDK, Clerk packages, React, Zod, Remotion, and
   affected transitive dependencies. The final npm and OSV scans report zero
   known vulnerabilities in both lockfiles.
2. Restricted authentication-bypassing demo mode to `NODE_ENV=development`
   with a loopback application URL.
3. Removed a personal support email from source and setup documentation.
4. Stopped logging a raw post-send datastore exception that could have carried
   connection details.
5. Reduced the unauthenticated health response to status and provider-readiness
   booleans.
6. Prevented the feedback relay from following redirects or accepting endpoint
   URLs containing embedded credentials.
7. Added baseline response hardening headers for framing, MIME sniffing,
   referrers, browser permissions, and HTTPS transport.
8. Moved the cron-secret helper out of the route module so the updated Next.js
   route contract builds cleanly, while preserving constant-time comparison.
9. Fixed a clean-clone test assumption about an untracked empty directory.
10. Removed an unused header-trusting authentication helper from the published
    application surface.
11. Changed ignored local credential files from mode `0644` to owner-only
    `0600` on the reviewed development machine.

## Credential and personal-data checks

- Gitleaks found no secret in the private Git history.
- Gitleaks found no secret in the pre-import public Git history.
- Gitleaks found no secret in the final publication tree.
- Eleven current local secret values were compared in memory against every
  historical private-repository blob. None matched.
- Local credential files do contain expected development credentials, but they
  are ignored, were never committed, are not part of the public import, and had
  their filesystem permissions restricted.

Because no active credential was found in Git history or the publication
snapshot, this review found no evidence-based reason to rotate a deployed
credential. Rotation would be required immediately if later evidence shows a
credential reached Git, a log, an artifact, or an unauthorized party.

## Final verification

| Check | Result |
|---|---:|
| Unit and security tests | 229 passed, 0 failed |
| ESLint | 0 warnings, 0 errors |
| TypeScript | Passed |
| Next.js production build | Passed |
| npm audit | 0 known vulnerabilities |
| OSV-Scanner | 0 known vulnerabilities |
| Semgrep | 0 findings |
| Gitleaks, publication snapshot | 0 findings |

## Remaining limits

This was an AI-assisted source, dependency, history, and configuration review.
It did not include a professional penetration test, independent code audit,
Google restricted-scope assessment, cloud-account compromise simulation, or a
full live-provider adversarial exercise. InboxPort remains an invite-only
prototype. The limitations in [Known limitations](limitations.md) still apply.
