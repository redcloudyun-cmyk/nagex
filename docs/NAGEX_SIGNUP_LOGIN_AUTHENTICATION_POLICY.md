# NAgex Signup, Login & Email Verification Policy

**Document Type:** Product / Security Architecture  
**Project:** NAgex  
**Status:** Approved Baseline  
**Scope:** Consumer sign-up, social login, email verification, account linking  
**Related Milestones:** R13 Identity & Account Lifecycle, R16 Enterprise Identity / SSO

---

## 1. Purpose

This document defines the canonical sign-up and login policy for NAgex general users.

The initial supported authentication methods are:

1. Email + Password
2. Sign in with Google
3. Sign in with Microsoft

Kakao, Naver, Facebook, Apple, and other social providers are outside the initial implementation scope unless separately approved.

Enterprise SSO such as Microsoft Entra ID, Google Workspace federation, generic OIDC, and SAML is handled separately under the Enterprise Identity architecture.

---

## 2. Canonical Sign-in Options

The NAgex sign-in screen should provide:

```text
Continue with Google

Continue with Microsoft

──────── OR ────────

Email
Password

[Sign in]

Create account
Forgot password
```

The account creation screen should provide:

```text
Continue with Google

Continue with Microsoft

──────── OR ────────

Email
Password
Confirm Password

[Create account]
```

Google and Microsoft are authentication providers.

Gmail itself is **not** the NAgex email-verification mechanism.

---

## 3. Email Address Policy

NAgex must not restrict direct sign-up to Gmail addresses.

Valid addresses may include, for example:

```text
user@gmail.com
user@outlook.com
user@naver.com
user@company.com
user@company.co.kr
```

Any standards-compliant email address may be used, subject to normal validation and abuse-prevention controls.

The internal user identifier must remain the immutable NAgex `user_id` UUID.

An email address must never be used as the primary internal identity key.

---

## 4. Email + Password Registration

Direct registration flow:

```text
Email
→ Password
→ Password Confirmation
→ Terms / Privacy Acceptance
→ Account Created as PENDING_VERIFICATION
→ Verification Email Sent
→ Email Verification
→ Account becomes ACTIVE
```

Required server-side controls:

- Normalize email consistently.
- Validate email format.
- Reject duplicate active identities according to the identity policy.
- Enforce password policy.
- Validate Terms and Privacy acceptance.
- Apply signup rate limiting.
- Never log plaintext passwords.
- Never expose whether another user's account exists beyond the defined safe error contract.

---

## 5. Email Verification

Email verification applies to **Email + Password** registration.

It is not necessary to perform a second NAgex email-verification step after a valid Google or Microsoft authentication flow when the provider's verified identity claim satisfies the configured trust policy.

Recommended NAgex verification UX supports both:

### 5.1 Six-digit verification code

Example:

```text
Verification code: 483921
```

### 5.2 Verification link

Example:

```text
[Verify Email Address]
```

Both methods should resolve to the same server-side verification transaction.

---

## 6. Verification Token Security

Verification codes/tokens must be:

- cryptographically random;
- single-use;
- time-limited;
- rate-limited;
- invalidated after successful use;
- stored only as a secure hash where practical;
- excluded from application, analytics, and audit logs in plaintext.

The system must reject:

- expired verification tokens;
- replayed tokens;
- tokens issued for another identity;
- malformed tokens;
- excessive retry attempts.

---

## 7. Transactional Email Delivery

Production email verification must not depend on a personal Gmail inbox or Gmail SMTP account.

Recommended initial provider:

```text
Resend
```

Alternative providers may include:

```text
Amazon SES
Postmark
SendGrid
```

Recommended sender pattern:

```text
NAgex <no-reply@agex.site>
```

When a dedicated NAgex mail domain is available:

```text
NAgex <no-reply@nagex-domain>
```

The production sender domain must have appropriate DNS authentication configured, including SPF/DKIM and, when operationally appropriate, DMARC.

Provider API keys must be stored in server-side secrets/environment configuration and must never be exposed to browser code.

---

## 8. Google Authentication

Google authentication should use standard OAuth 2.0 / OpenID Connect flows.

Conceptual flow:

```text
User
→ Continue with Google
→ Google authentication
→ OAuth/OIDC callback
→ Validate state / nonce / issuer / audience / signature
→ Resolve provider identity
→ Create or link NAgex identity
→ Create NAgex session
```

The stable external identity key is the provider subject identifier, not the email address.

Example identity-link concept:

```text
provider = GOOGLE
external_subject = Google OIDC sub
user_id = immutable NAgex UUID
```

NAgex must not use a Gmail address as the Google account primary key.

---

## 9. Microsoft Authentication

Microsoft authentication should use OAuth 2.0 / OpenID Connect.

Conceptual flow:

```text
User
→ Continue with Microsoft
→ Microsoft authentication
→ OAuth/OIDC callback
→ Validate state / nonce / issuer / audience / signature
→ Resolve provider identity
→ Create or link NAgex identity
→ Create NAgex session
```

Microsoft authentication should be designed so the architecture can later support both consumer Microsoft identities and enterprise Microsoft Entra identities without changing the NAgex immutable internal `user_id` model.

---

## 10. Identity Linking Model

A single NAgex user may eventually have multiple authentication methods.

Example:

```text
NAgex User
user_id = UUID

├─ Local Email Credential
├─ Google Identity Link
└─ Microsoft Identity Link
```

The authentication method and the NAgex account are different concepts.

Provider identity records should minimally contain:

```text
identity_link_id
user_id
provider
external_subject
provider_email
created_at
last_login_at
```

Recommended unique constraint:

```text
provider + external_subject
```

An external provider identity must not be linked to more than one NAgex user.

---

## 11. Critical Account-Linking Rule

**Do not silently merge accounts because email addresses match.**

Example:

```text
Existing NAgex account:
user@example.com

Google login:
user@example.com
```

The system must not assume these are automatically the same trusted identity.

Account linking should require one of the following:

1. the user is already authenticated to the existing NAgex account and explicitly links Google/Microsoft; or
2. another explicit re-authentication / secure account-linking flow proves ownership of both identities.

This rule exists to prevent account takeover through unsafe email-based identity merging.

---

## 12. Social Login Registration

For first-time Google or Microsoft authentication:

```text
Provider authentication succeeds
→ provider identity validated
→ no existing provider link found
→ NAgex account creation policy evaluated
→ new immutable user_id created
→ provider identity linked
→ profile initialized
→ session created
```

If Terms/Privacy consent is legally or operationally required, the user must complete that consent before full activation.

---

## 13. Social Login Returning User

```text
Provider authentication succeeds
→ provider + external_subject lookup
→ linked NAgex user found
→ account status checked
→ NAgex session created
```

Account status rules from R13 remain authoritative.

Examples:

```text
ACTIVE              → login allowed
LOCKED              → login denied
DISABLED            → login denied
DELETION_PENDING    → apply defined recovery/cancel policy
DELETED             → login denied
```

---

## 14. Password Recovery

Password recovery applies to users with a local Email + Password credential.

Google-only or Microsoft-only users do not need an NAgex local-password reset unless they have separately created a local credential.

Password-reset request responses must not reveal whether an account exists.

Example safe response:

```text
If an account exists for this address,
password reset instructions have been sent.
```

---

## 15. Session Policy

All successful authentication methods ultimately create the same NAgex session model.

```text
Local login
Google login
Microsoft login
Enterprise SSO
        ↓
NAgex Session
```

The provider access token must not itself become the permanent NAgex application session.

NAgex session controls remain authoritative:

- HttpOnly cookie
- Secure in production
- SameSite policy
- server-side revocation
- session rotation
- logout
- logout-all
- password/security-event revocation rules

---

## 16. UI Policy

Initial authentication UI priority:

```text
1. Continue with Google
2. Continue with Microsoft
3. Email + Password
```

Do not add unused social buttons solely to appear comprehensive.

The initial release intentionally excludes:

```text
Kakao
Naver
Facebook
Apple
GitHub
X/Twitter
```

They may be added later only when product demand justifies the additional identity, security, policy, and maintenance surface.

---

## 17. Consumer Login vs Enterprise SSO

The following must remain conceptually separate.

### General-user authentication

```text
Email + Password
Google
Microsoft
```

### Enterprise identity

```text
Microsoft Entra
Google Workspace
Generic OIDC
SAML
SCIM provisioning
```

They may reuse common identity-link and session infrastructure, but enterprise tenant policy must not be collapsed into ordinary social login behavior.

---

## 18. Required Security Invariants

The following rules are mandatory:

```text
Email match alone != account ownership

Provider email != immutable identity key

provider + external_subject uniquely identifies an external identity

Google/Microsoft token != NAgex application session

Unverified local email cannot become ACTIVE

Expired/replayed verification token = DENY

Disabled/locked/deleted account = DENY

Provider identity cannot link to two NAgex users

Social login cannot bypass tenant/RBAC rules

Secrets/tokens/passwords must never appear in logs
```

---

## 19. Initial Implementation Scope

### Phase 1

Implement:

```text
Email + Password
Email verification
Google OAuth/OIDC
Microsoft OAuth/OIDC
Identity linking foundation
Unified NAgex session creation
Account-linking security rules
EN/KR UI
```

### Phase 2 / Future

Only when required:

```text
Additional social login providers
Passwordless login
Passkeys / WebAuthn
Magic link
Phone/SMS verification
```

Enterprise federation remains governed by the R16 Enterprise Identity specification.

---

## 20. Acceptance Criteria

The feature is not complete until at least the following pass:

```text
EMAIL_SIGNUP=PASS
EMAIL_VERIFICATION_CODE=PASS
EMAIL_VERIFICATION_LINK=PASS
EXPIRED_VERIFICATION=PASS
VERIFICATION_REPLAY=PASS

GOOGLE_FIRST_LOGIN=PASS
GOOGLE_RETURNING_LOGIN=PASS

MICROSOFT_FIRST_LOGIN=PASS
MICROSOFT_RETURNING_LOGIN=PASS

ACCOUNT_LINK_EXPLICIT=PASS
EMAIL_MATCH_SILENT_MERGE=DENY
DUPLICATE_PROVIDER_SUBJECT=DENY

LOCKED_ACCOUNT_SOCIAL_LOGIN=DENY
DISABLED_ACCOUNT_SOCIAL_LOGIN=DENY

SESSION_CREATION=PASS
SESSION_REVOCATION=PASS

EN_UI=PASS
KR_UI=PASS

SECURITY_REGRESSION=PASS
```

---

## 21. Final Product Decision

The approved initial NAgex authentication set is:

```text
Email + Password
Google
Microsoft
```

Email verification is performed by **NAgex transactional email**, not by Gmail.

Google and Microsoft authenticate their own provider identities.

NAgex remains responsible for:

```text
internal user identity
account state
identity linking
session management
authorization
account lifecycle
audit
```

This document is the baseline policy for general-user signup and login until superseded by a later approved specification.
