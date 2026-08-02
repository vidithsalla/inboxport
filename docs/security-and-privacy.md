# Security and privacy

## Plain-language summary

InboxPort does not build or retain a copy of the user's inbox. Search results
and messages are fetched from Gmail or Outlook on demand, passed to the
authorized browser or AI client, and excluded from the normal application
database and audit log.

That does not mean InboxPort stores nothing. It stores the encrypted provider
credentials and control-plane records required to connect accounts, enforce
permissions, revoke access, and record operational decisions.

## Data map

| Data | Retained by InboxPort | Treatment |
|---|---:|---|
| Provider refresh credential | Yes | Envelope-encrypted per account |
| Provider access token | No | Refreshed just in time and held transiently |
| Connected email address | Yes | Encrypted; keyed fingerprint used for lookup |
| Message or thread content | No normal retention | Fetched on demand and returned with `no-store` responses |
| Search query | No | Used transiently and excluded from audit |
| Provider-side draft content | No normal retention | Draft stays at Gmail or Outlook |
| Pending approved-send content | Yes, briefly | Exact encrypted envelope, maximum ten minutes |
| Account and installation IDs | Yes | Internal control-plane identifiers |
| Permission and revocation state | Yes | Required for policy enforcement |
| Audit events | Yes | Operation, decision, account, time, reason, result class/count |
| Raw provider errors | No | Reduced to safe categories |

## Audit boundary

Audit events are designed to answer which internal actor performed which
operation against which account, when, whether it was allowed, and how the
provider classified the result.

Normal audit events exclude:

- Search queries
- Email addresses
- Senders and recipients
- Subjects and snippets
- Message bodies and attachments
- Provider tokens and cookies
- Raw provider responses and errors

The implementation has a runtime audit guard and a second guard at the
repository boundary to reject content-shaped fields and obvious email or token
values.

## Credential boundary

Refresh credentials and connected addresses are encrypted before database
storage. The current prototype uses per-record envelope encryption and a
separate environment-held wrapping key. This is a hobby-stage deployment
boundary, not the intended production key-management design. A consumer launch
would require a managed KMS, workload identity, key rotation, and reviewed
operational procedures.

## Provider permission versus InboxPort permission

InboxPort's grants are application-enforced permissions. They are valuable for
limiting what a particular AI installation can do, but they do not narrow the
underlying OAuth token at the provider.

For example, Gmail's `gmail.compose` scope is provider-level send-capable even
though InboxPort does not expose a direct-send MCP tool. If InboxPort's backend
or stored refresh credential were compromised, the internal policy layer would
not constrain an attacker holding the provider credential. This is why the
project is described as an agent-level control plane, not as provider-enforced
least privilege.

## Revocation boundary

Pausing an account, revoking a grant, or revoking an installation blocks future
InboxPort operations. It cannot retract email content already delivered to an
AI client's context or copied elsewhere. Revocation limits access going
forward; it does not undo prior disclosure.

