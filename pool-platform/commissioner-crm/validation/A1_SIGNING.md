# A1 signing and execution procedure (for the owner's personal review)

This file is the procedure around `A1_AUTHORIZATION.md`. It changes nothing in that file, so the reviewed text keeps
its hash. **A1 does not run until (1) the owner signs the authorization, (2) the signature and hashes are validated,
and (3) the owner gives a separate "run A1 now" approval.** Preparing this is not running it.

## The frozen objects (verified from the committed tree at `2882c7d`)

| Object | SHA-256 | What it is |
| --- | --- | --- |
| `validation/A1_AUTHORIZATION.md` | `8de895da4d7f75eb5654497a41c6e7c0f888f64d65c76d2a711725d872331c12` | the authorization text you reviewed |
| `validation/a1_run.sh` | `d63654bc4ccd91ae88bbf1641527b0827b0e13272916554fb837453db9c78557` | the fail-closed runner |
| `validation/P1_identity_helpers_004.sql` | `9ef14dea4ea0f0ff9270b06eb05339f7dfe114accf9c6264d7dd810a979666ae` | production helper check |
| `validation/P2_private_schema_inventory.sql` | `234b81f89d328107ff86b0564c32e57f25f220c8ad8da053dc2cbf82731e39d1` | `pool_platform_private` inventory |
| `validation/P3_crm_preconditions.sql` | `f652ecad1d7adcc1f474d1b0af9753e7a8aec1e14567d03cb350c1312cd2333d` | CRM preconditions |
| `neon-catalog-verify.sql` @ `2c6e2a80` | `40b20416909c0ca2c26e2e682cb4ad2c5ef0b87fc257ca79d259dce55a0e9b43` | AUTH-C catalog verifier |
| `neon-identity-audit.sql` @ `2c6e2a80` | `d512b94f8281fd201bcecb3efae3eb39fda2ab372b921d8f4a224bec012dca61` | AUTH-C identity audit |

Every value above was recomputed from the git objects in this session and equals the value pinned inside
`A1_AUTHORIZATION.md`. The `a1_run.sh` runner carries the same five SQL hashes and refuses any file that differs.

## Step 1 — confirm the reviewed text on your own machine

On a checkout of `ccr-321cd6b3-fu8f1j` at `2882c7d` (or later, as long as these files are unchanged):

    cd <repo>/pool-platform/commissioner-crm
    sha256sum validation/A1_AUTHORIZATION.md validation/a1_run.sh \
              validation/P1_identity_helpers_004.sql \
              validation/P2_private_schema_inventory.sql \
              validation/P3_crm_preconditions.sql
    git -C <repo> show 2c6e2a80:pool-platform/validation/neon-catalog-verify.sql | sha256sum
    git -C <repo> show 2c6e2a80:pool-platform/validation/neon-identity-audit.sql | sha256sum

Each must equal the table above. If any differs, stop: the package was altered after review.

## Step 2 — sign the authorization (choose one; the cryptographic form is preferred)

**2a. Detached cryptographic signature (preferred: verifiable, and it does not change the file).**
Sign the reviewed authorization with a key you hold. The trust anchor is your key; nothing in this session can
produce or verify it for you.

SSH key (same key family GitHub uses for signing):

    ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n file validation/A1_AUTHORIZATION.md
    # writes validation/A1_AUTHORIZATION.md.sig

GPG key:

    gpg --armor --detach-sign --output validation/A1_AUTHORIZATION.md.asc validation/A1_AUTHORIZATION.md

Keep the `.sig`/`.asc` beside the file. Do not commit your private key or passphrase.

**2b. Countersignature in the file (simpler; the signed hash is the reviewed hash).**
Fill the signature block at the end of `A1_AUTHORIZATION.md` with your name and the UTC time, and write the
**reviewed** hash `8de895da4d7f75eb5654497a41c6e7c0f888f64d65c76d2a711725d872331c12` on the "Signed-text SHA-256"
line. That hash is of the text as reviewed, before the block is filled, so record it rather than re-hashing the
edited file. Commit the filled file on the session branch.

## Step 3 — validate the signed copy (before any execution)

- 2a: `ssh-keygen -Y verify` against your `allowed_signers`, or `gpg --verify validation/A1_AUTHORIZATION.md.asc`,
  returns a good signature from your key over a file whose hash is `8de895da…`.
- 2b: the committed file's signature block names you and a UTC time, and the "Signed-text SHA-256" line reads
  `8de895da…`.

## Step 4 — the separate execution approval (second key)

A1 runs only after you send, in this session or to the operator, a message to the effect of:

    Run A1 now. Authorization 8de895da… is signed and validated.
    Owner: <name>   UTC: <time>

Signing (Step 2) and approving the run (Step 4) are deliberately two acts. Neither alone starts A1.

## Step 5 — the operator runs it (read-only), exactly this

On the operator's machine, with the production `service=` entry held only there, after Steps 1–4:

    # one-time: make sure the AUTH-C commit is present for the two files staged from it
    git -C <repo> fetch origin 2c6e2a805fa816638808cb2d96d430ee177453e6

    # confirm the runner itself is the reviewed one
    sha256sum <repo>/pool-platform/commissioner-crm/validation/a1_run.sh
    # expect d63654bc4ccd91ae88bbf1641527b0827b0e13272916554fb837453db9c78557

    PP_SERVICE=<production service entry, this machine only> \
    PP_OUT=<private dir outside any repo or synced folder> \
    PP_REPO=<repo> \
    bash <repo>/pool-platform/commissioner-crm/validation/a1_run.sh

The runner stages the five files, refuses any whose SHA-256 is not the pinned one, and for each file opens a
connection that it aborts unless `:HOST = ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech`,
`current_database() = neondb` and `current_user = neondb_owner`, then runs the file inside `BEGIN READ ONLY; …
ROLLBACK;` with `ON_ERROR_STOP`. It prints the verdict rows (`H99`, `X99`, `C99`, `I99`) and P2's row count, writes
the full rows to `PP_OUT/out/`, and fingerprints sources and outputs into `PP_OUT/sha256sums.txt`. Any error or
guard refusal is an `A1 STOP` and ends the run.

If psql is not available, the Neon SQL Editor is the fallback: run the same five files in the same order, each in
its own `BEGIN READ ONLY; … ROLLBACK;`, after checking the three guard values by hand, and paste the rows into the
record.

## Step 6 — review outputs for redaction, then share only the verdicts

The `PP_OUT/out/` files hold the rows. By construction they carry no id, email, token, key, password or connection
string, but P2's comment and ACL strings and the `actual` strings of C and X rows may name roles and function
signatures. Review before sharing, then report `H99`, `X99`, `C99`, `I99` and the P2 inventory (§5 of the
reconciliation doc has the expected-vs-finding split). Raw outputs stay in the private directory.
