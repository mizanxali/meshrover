# World ID Agent Pass: integration debrief

How Mesh Rover uses it: before a rover enters restricted zone C, the base runs
the device flow, sends the link and code to the operator's phone over the mesh
(the phone app is the only place to approve), polls the token endpoint, and validates the ID token
itself (`src/base/world.ts`). A validated `(iss, sub)` maps to an enrolled
operator, and the rover enters only on a single-use, short-lived approval
naming that operator. Declined, expired and unreachable attempts all leave the
rover stopped, with a `denied` entry in the episode log.

Kept up to date during the build. Dates are IST, November 2026.

## Time to first success

- **Device authorization:** under an hour from creating the portal app. The
  first `device_authorization` call with `client_secret_basic` returned 200
  with `verification_uri_complete`, `user_code`, `expires_in: 1200` and
  `interval: 5`. The production endpoint still answers the same way from the
  base (6 Nov).
- **A validated ID token:** on 6 Nov, about a day after the first device
  authorization, after we registered a sandbox portal app and verified a
  sandbox World ID in the sandbox app. The iPhone's sandbox World App enrolled an
  operator (`acr` `…/acr/orb`), and its next approval let rover A into zone C
  26 s after it reached the gate. Until then no account we could create could
  complete the flow (see below).

## What worked well

- The discovery document is complete: device grant, every client auth method,
  RS256, `claims_parameter_supported`. With it and `jose`, validation is about
  ten lines.
- The device flow suits an agent with no browser. The poll loop
  (`authorization_pending`, `slow_down`, then stop on anything else) is
  standard OAuth, and the docs' poll table is clear.
- The docs say plainly what the device grant doesn't support (`nonce`,
  `prompt`, `max_age`) and that it always requires fresh authentication.

## Friction

1. **No way to get a verified test identity on our own.** The production World
   App offered only Orb verification, with no Selfie Check, so a new account
   couldn't satisfy the app's accepted credentials. The sandbox app (TestFlight)
   registered a V4 account, but "Fake verification" failed with "V4 protocol
   and credential issuance must both be enabled for this account". That is an
   account switch only World's team can flip, so we were blocked on a human
   during a 36-hour hackathon.
2. **"Ask for Face Auth" silently needs an Orb-verified account.** Nothing in
   the portal says so when you turn it on.
3. **`acr_values_supported` lists only `…/acr/orb` and `…/acr/orb-face`**, but
   the ID token docs also describe `…/acr/selfie` and `…/acr/selfie-face`. We
   couldn't tell from discovery alone whether a Selfie-level request is
   allowed.
4. **Telling a fresh proof from a passkey takes inference.** A passkey login
   reports `amr` `["pop", "user", "mfa"]`, so checking for `pop` isn't enough.
   We first accepted a proof only when `amr` contained `pop` and not `mfa`,
   inferred from the examples. On 6 Nov the sandbox app returned exactly
   `["pop", "user", "mfa"]` through the device flow, and World's team at the
   booth confirmed a passkey sign-in is fine, so we now require `pop` and an
   `auth_time` inside the attempt. The docs could say this outright.
5. **The error for "the person declined in World App" isn't documented.** We
   treat `access_denied` as a decline, but the docs also return it for an unmet
   essential `acr` and for a `sub` mismatch, so the base can't tell the
   operator which one happened. Seen on 6 Nov: a second sandbox identity, on
   Android, got `access_denied` with `error_description` "Authorization was
   denied." 10 to 25 s after approving, five times in a row, while the
   iPhone's identity enrolled with the same client. Nothing in the response
   says why.
6. **A redirect URI is required for a device-only client.** We registered a
   placeholder HTTPS URL that's never used.
7. **The client auth method can't be changed after registration.** It's easy
   to choose wrong at first, before reading the token-endpoint docs.

## The one improvement with the most impact

**A self-serve test identity:** a sandbox account that can complete a device
flow with an Orb- or Selfie-level credential, with no manual enabling. Every
other item above cost minutes. This one blocked the success path for most of
the event.
