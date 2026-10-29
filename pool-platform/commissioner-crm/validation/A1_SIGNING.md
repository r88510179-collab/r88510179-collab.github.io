# A1 signing and execution procedure (for the owner's personal review)

This file is the procedure around `A1_AUTHORIZATION.md`. It changes nothing in that file, so the reviewed text keeps
its hash and the owner's detached signature over it stays valid. **A1 does not run until (1) the authorization is
signed, (2) the runner acknowledgment `A1_RUNNER_ACK.txt` is signed, (3) the Mac preflight reports READY, and (4) the
owner gives a separate "Run A1 now" approval.** Preparing this is not running it.

The owner's checkout is `$HOME/Documents/commissioner-crm-a1` on the owner's Mac; every command below uses that path.
The owner is also the operator: A1 runs from the owner's own Terminal, never from an AI session or a cloud machine.

## The frozen objects

| Object | SHA-256 | What it is |
| --- | --- | --- |
| `validation/A1_AUTHORIZATION.md` | `8de895da4d7f75eb5654497a41c6e7c0f888f64d65c76d2a711725d872331c12` | the authorization text, signed by the owner (unchanged) |
| `validation/A1_RUNNER_ACK.txt` | `cccc8c1383d9ea650460424c075a28f9f0e0d6d20c52d1f151fe2841cb21b1df` | the supplement the owner signs: binds runner version 2 to the authorization |
| `validation/a1_run.sh` (version 2) | `314ef9e4f0d0eeb264ce51cbc30f4f10a52be07179a76512da53820c2f3400b5` | the fail-closed runner; replaces version 1 (`d63654bc…`), which must not be run |
| `validation/a1_run.test.sh` | `f38d62c109e32ae9e3f2459b5e82eaf93bca7dd7f64f5296989c75c231f0c09b` | its regression suite (1089 assertions, local only, never Neon) |
| `validation/a1_preflight_mac.sh` | `36a5df0b8bceb45c54f6a9160bc30275377bd6043d3f561c1863beebfbcca4a8` | the Mac preflight: checks files, signatures and psql setup without connecting |
| `validation/a1_preflight_mac.test.sh` | `16f64d49c1ea54bc365fef9e4f04fd64a17f4288ae5f5572d6fc2a31a5930d41` | its regression suite (654 assertions, local only) |
| `validation/P1_identity_helpers_004.sql` | `9ef14dea4ea0f0ff9270b06eb05339f7dfe114accf9c6264d7dd810a979666ae` | production helper check |
| `validation/P2_private_schema_inventory.sql` | `234b81f89d328107ff86b0564c32e57f25f220c8ad8da053dc2cbf82731e39d1` | `pool_platform_private` inventory |
| `validation/P3_crm_preconditions.sql` | `f652ecad1d7adcc1f474d1b0af9753e7a8aec1e14567d03cb350c1312cd2333d` | CRM preconditions |
| `neon-catalog-verify.sql` @ `2c6e2a80` | `40b20416909c0ca2c26e2e682cb4ad2c5ef0b87fc257ca79d259dce55a0e9b43` | AUTH-C catalog verifier |
| `neon-identity-audit.sql` @ `2c6e2a80` | `d512b94f8281fd201bcecb3efae3eb39fda2ab372b921d8f4a224bec012dca61` | AUTH-C identity audit |

## Why a supplemental acknowledgment, and why it is the smallest valid step

The signed authorization names the runner by its path only (section 2) and pins the five SQL files, not the runner.
Its signature therefore still verifies, and the SQL that A1 runs is unchanged. But the package you reviewed and
signed against included runner version 1 (`d63654bc…`), and version 2 is different code that will act on production
under your authority. Your signature has to cover the exact runner bytes again. Re-signing the authorization would
need a new text and a new review; an approval in chat would not bind the bytes. One short signed text that pins the
new runner hash and states where version 2 reads the authorization more strictly is the smallest step that keeps
the chain cryptographic: `A1_RUNNER_ACK.txt`. Read its section 4 before signing.

## The independent review

Round 3 of the independent review has not reported yet. Do not sign the acknowledgment before this section
records its verdict.

## Step 1: update the checkout and run the preflight

    git -C "$HOME/Documents/commissioner-crm-a1" pull --ff-only origin ccr-321cd6b3-fu8f1j
    bash "$HOME/Documents/commissioner-crm-a1/pool-platform/commissioner-crm/validation/a1_preflight_mac.sh"

The preflight never connects to anything, never opens your private key, and never prints a password, a key, a
connection string or any value from your service or password file (only key names, counts, and whether each value
is what A1 needs). It checks every hash in the table above (except its own and the two test suites'), verifies
`A1_AUTHORIZATION.md.sig` against your public key `$HOME/.ssh/crm_a1_signing_ed25519.pub` as principal
`crm-a1-owner`, finds the one entry in your psql service file whose host is the production host, and checks that
entry (it refuses any key that would change or break A1's connection, a misspelt one included), its TLS root
certificate, your password file's permissions and matching line (by count only), and the evidence directory
`$HOME/commissioner-crm-a1-evidence`. Each problem is a `[STOP]` or `[TODO]` line with the
exact fix. When everything else is in place, its first run reports exactly one `[TODO]`: the acknowledgment is not
signed yet.

## Step 2: sign the acknowledgment (once)

Read `A1_RUNNER_ACK.txt`, then sign it with the key that signed the authorization. The preflight prints this command
with your paths filled in:

    ssh-keygen -Y sign -f "$HOME/.ssh/crm_a1_signing_ed25519" -n file \
      "$HOME/Documents/commissioner-crm-a1/pool-platform/commissioner-crm/validation/A1_RUNNER_ACK.txt"

It writes `A1_RUNNER_ACK.txt.sig` beside the file. Keep it there, with `A1_AUTHORIZATION.md.sig`; neither is secret.

## Step 3: run the preflight again

It must end with `PREFLIGHT RESULT: READY`, both signatures shown as `Good "file" signature for crm-a1-owner`, and the
exact A1 command printed. Send that output to the session: it shows no value from your service or password file,
so it holds no password.

## Step 4: the separate execution approval

A1 runs only after you send, as its own message:

    Run A1 now. Authorization 8de895da… and runner acknowledgment cccc8c13… are signed; the preflight is READY.

Signing (Steps 2 and 3) and approving the run (Step 4) are deliberately separate acts. Neither alone starts A1.

## Step 5: run it, read-only, exactly as the preflight printed

The preflight prints the command with your service entry's name (and a `PATH=` prefix only if psql is not already on
your PATH). Its shape is:

    PP_SERVICE=… PP_REPO="$HOME/Documents/commissioner-crm-a1" \
    PP_OUT="$HOME/commissioner-crm-a1-evidence/run-$(date -u +%Y%m%dT%H%M%SZ)" \
    PP_RUNNER_SHA256=314ef9e4f0d0eeb264ce51cbc30f4f10a52be07179a76512da53820c2f3400b5 \
    bash "$HOME/Documents/commissioner-crm-a1/pool-platform/commissioner-crm/validation/a1_run.sh"

The runner checks the authorization, itself and the five SQL files against their pinned SHA-256, shows the target
and the hashes, and waits for you to type `RUN A1`. For each file it connects to
`ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech`, port 5432, `neondb`, `neondb_owner` (pinned in its own
connection string, with `sslmode=verify-full`); quits unless the guard confirms that session, the effective search
path is exactly `pg_catalog, public`, and `public` holds no function or operator that could stand in for a
`pg_catalog` one; runs the file inside `BEGIN READ ONLY; … ROLLBACK;`; and checks every line. P2's run adds one row
of the runner's own: what depends on `pool_platform_private` from outside it (directly or through views and
functions), its members that P2 does not list, the views in `public` a Data API role can read, and the login event
triggers. The last line is the result:

- `A1 RESULT: HOLD (exit 10)`: every verdict and required row passed and no STOP condition occurred; the listed items
  need your written reading. This is the best result the runner gives, because P2 is never an automatic PASS.
- `A1 RESULT: STOP (exit 2, 3 or 4)`: before any connection (2), at a connection (3) or on a check (4). The run ended
  at the first STOP; the reason is printed, and `manifest.txt` records it. A search path other than the default, a
  function or operator in `public` that could stand in for a `pg_catalog` one, a server warning, or a line break or
  tab inside a value is a STOP too (acknowledgment, sections 3 and 4).

If psql cannot be used, the Neon SQL Editor remains the authorization's fallback (same files, same order, each in its
own `BEGIN READ ONLY; … ROLLBACK;`, hashes and guard values checked by hand), but the runner's row checks then have to
be done by hand too, so prefer the runner.

## Step 6: review, then share only the verdicts

The evidence directory holds `manifest.txt` (the runner's hash, every source hash, each result, the outcome),
`sha256sums.txt`, `src/` (the exact files run) and `out/` (every row). By construction the rows carry no id, email,
token, key, password or connection string, but P2's comment and ACL strings and the `actual` strings of C and X rows
may name roles and function signatures: review before sharing. Then send the result line, the per-file lines and the
HOLD items. For a HOLD, A1 becomes PASS when you record, in writing, your reading of each HOLD item (for P2, every
row of `out/P2_private_schema_inventory.tsv`, explained from the window record). Raw outputs stay in the private
directory.
