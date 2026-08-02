# Threat model

## Protected assets

- Gmail and Outlook refresh credentials
- Mail content returned on authorized requests
- Provider-side drafts and sends
- Tenant, account, and AI-installation isolation
- Permission and revocation state
- Audit integrity and content minimization

## Trust boundaries

InboxPort treats all mail content and all MCP tool arguments as untrusted.
Authenticated users, authenticated MCP installations, the application runtime,
the control-plane database, and the two mail providers are separate trust
boundaries.

## Threats and implemented controls

| Threat | Control |
|---|---|
| A new AI client reads an inbox automatically | New installations start with zero grants |
| One installation uses another installation's grant | Installation identity is part of every policy snapshot |
| Cross-user or cross-account object access | Repository lookups and mutations are scoped by owner and account |
| A revoked client keeps using a cached decision | Current grant and revocation state is re-read for every tool call |
| A paused account is accessed by a foreground or background path | Pause is checked before provider access; sync lookups exclude paused accounts |
| Mail content enters audit or logs | Restricted audit schema, repository-boundary validation, and telemetry redaction |
| A draft changes after the owner reviews it | Draft is re-fetched and re-hashed immediately before dispatch |
| An AI client approves its own send | No MCP approval tool exists; approval requires the authenticated owner console |
| Ambiguous provider response causes an automatic duplicate send | Ambiguous outcomes become `delivery_unknown` and are never retried automatically |
| Header injection through recipients or subject | Newlines are rejected at the MCP input boundary |
| Credential or approval ciphertext is moved between records | Encryption context binds ciphertext to its user, account, purpose, and record |
| Attachment content bypasses the reviewed send model | Approval-gated sending rejects drafts with attachments |

## Explicitly out of scope or incomplete

- A compromised InboxPort runtime or stolen provider refresh credential
- Malware or extensions in the user's browser
- Content already received and retained by an AI client
- Provider-side account compromise
- Independent validation of Gmail or Microsoft security guarantees
- Independent penetration testing of the current prototype
- Full draft provenance enforcement across AI installations
- Outlook push-notification parity

## Security-claim rule

InboxPort does not claim that application-level grants replace provider OAuth
security. It also does not claim end-to-end encryption, zero knowledge, zero
data processing, or production readiness.

