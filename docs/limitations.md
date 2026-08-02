# Known limitations

InboxPort is an invite-only prototype. The following limits are current and
material.

## Validation and demand

- Usage has been limited to the builder and invited personal contacts.
- There is no evidence yet of independent retention or integration demand.
- Automated tests are extensive, but live end-to-end provider testing remains
  limited.
- The project has not undergone an independent penetration test or security
  audit.

## OAuth and launch constraints

- Gmail read access uses Google's restricted `gmail.readonly` scope.
- Gmail draft and approved-send support uses `gmail.compose`, which is also a
  restricted and provider-level send-capable scope.
- The Google OAuth app remains in Testing and is limited to explicitly added
  test users. Public access would require Google's verification process and any
  applicable security assessment.
- Managed Microsoft 365 tenants may block user consent or require administrator
  approval.

## Implementation constraints

- The current hobby deployment uses Turso/libSQL and an environment-held vault
  wrapping key. The accepted production target is managed PostgreSQL and a
  managed KMS with workload identity and rotation.
- Approval-gated sending does not support attachments.
- Draft provenance is not persisted, so a granted installation can update an
  existing draft in that account, not only drafts it originally created.
- Outlook push notifications are not implemented.
- MCP identity support depends on a provider integration that is currently
  documented as beta by its vendor.
- Revocation blocks future InboxPort access but cannot erase mail already
  delivered to an AI client.

## Product constraint

InboxPort controls access to email but does not itself own an email workflow
such as triage, follow-up management, or scheduling. The current pilot is also
testing whether the right long-term form is a standalone product, a component
inside an AI email experience, or infrastructure for teams building agents.

