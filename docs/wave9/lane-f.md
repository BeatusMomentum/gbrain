# Fix wave 9, lane F: auth, CLI and config

Integrator notes for the release files. Nothing here is a CHANGELOG header;
copy the lines below into the release entry and the upgrade-note table.

## Migrations (placeholder numbers, renumber after master's latest)

| Placeholder | Name | Commit | What |
|---|---|---|---|
| v209 | `w9_f_clamp_oauth_token_ttl` | 5ef75378 | Handler: clamps `oauth_clients.token_ttl` into 60..7776000 (above → 7776000, 1..59 → 60, ≤0 → NULL), bumps `grant_revision`, writes `oauth_grant_audit` (`clamp_token_ttl`); shortens outstanding access tokens to `created_at + 7776000` (never lengthens; audit `shorten_access_tokens`). Refresh tokens and legacy bearer tokens untouched. Idempotent. |
| v210 | `w9_f_function_search_path` | daf7426b | Re-creates the three fact fingerprint SQL functions (qualified built-ins, byte-identical outputs) and ALTERs every public `gbrain_*` / `auto_enable_rls` plpgsql function with no setting to `search_path = pg_catalog, public`. Idempotent. |

Both tests find their migration by name (`MIGRATIONS.find(m => m.name.endsWith(...))`), so renumbering needs no test edit. Regenerate `registry.generated.ts` and `test/fixtures/goldens/migrations/records.json` after renumbering.

## CHANGELOG lines

- **OAuth access tokens never outlive 90 days.** Issuance caps every access token at 7,776,000 seconds, whatever a client's stored lifetime, `oauth.dcr_ttl_max_seconds` or `serve --http --token-ttl` says, and `serve --token-ttl` refuses values outside 60..7776000 at startup. The upgrade brings stored client lifetimes into that range and shortens already-issued access tokens to 90 days after issue; `gbrain auth clients` marks affected clients and `whoami` names the `--token-ttl` repair choice. (#5040)
- **`--source` on `timeline-add`, `ontology-add` and `takes add|update|supersede` is provenance on every route.** A provenance URL is no longer refused as an invalid source id, a provenance value that is also a source name no longer redirects the write, and a running `gbrain serve` keeps the provenance. (#5087)
- **Skill retention and proposal commands work while `gbrain serve` owns the brain.** `get_skill_retention`, `prune_skill_revisions`, `retain_skill_revision` and `import_skill_proposal` no longer answer `unknown_tool` to the local CLI. (#5864)
- **Every `gbrain import` refusal says why and what to run.** A symlinked root on a managed brain and a refused source filesystem lock no longer exit 1 silently; the multi-source warning also names `GBRAIN_SOURCE` and `GBRAIN_ALLOW_DEFAULT_WRITE`. (#5268, thanks @andreineacsu, #5515)
- **`config get/set/unset embedding_disabled` and `config get/show schema_pack` report and change the value the runtime uses.** `embedding_disabled` writes both planes, the enable path clears both, and `schema_pack` shows the tier `schema active` resolves. (#5253)
- **`gbrain doctor` warns instead of failing on missing RLS when nothing exposes the public schema.** It still fails when PostgREST roles or a Supabase URL are present. (#4939)
- **`extract_health` dates a high halt rate by the last halt** ("last halt 4d ago"), not the last clean run. (#5863)
- **Doctor's migration row reads the ledger like `get_health`:** a `--force-retry` marker resets the wedge, and a host migration a newer one skipped past is reported with `gbrain apply-migrations --yes`. (C-NEW-2, C-NEW-3)
- **Code pages that contain a facts/takes fence marker are withheld from remote reads** and left out of `repair safe-chunks` and `safe_index_pending` counts. (D-NEW-2)
- **Remote code reads stay suspended with a clearer error** that names the follow-up (#5052) and points at `search`/`query`. (#5052)
- **Every gbrain plpgsql function pins `search_path`;** the fingerprint functions keep identical output and stay inlinable; the `check:search-path` guard now sees every definition. (#5190, C-NEW-1)

## Upgrade-note rows

| What changed | Who is affected | Doctor / check | How to opt back |
|---|---|---|---|
| Access tokens capped at 90 days; stored client lifetimes clamped; outstanding access tokens shortened to issue + 90 days | OAuth clients whose stored lifetime or server `--token-ttl` exceeded 90 days, and their already-issued access tokens. Tokens older than 90 days stop working; refresh tokens and machine credentials get new ones; a native OAuth client with no refresh token reconnects | `gbrain auth clients` (`token_lifetime_clamped`), `whoami` `token_ttl_invalid`; docs/mcp/ADMIN.md#access-token-lifetime | None (security cap). Restart every running `gbrain serve --http` after upgrading |
| `serve --http --token-ttl` validated | Launch scripts passing a value outside 60..7776000 or a non-number (it used to fall back to 3600 silently) | `serve` refuses at startup with the bounds message | Pass a value in range or omit the flag |
| `--source` is provenance for ops that own a `source` param | Scripts that used `timeline-add --source <source-id>` to pick the destination source | JSON result `source_id` names the destination | Use `GBRAIN_SOURCE=<id>` or `.gbrain-source` for the destination |
| `config set embedding_disabled` writes both planes; `set false`/`unset` actually re-enable | Keyless brains being re-enabled | `gbrain config get embedding_disabled` shows both planes | `gbrain config set embedding_disabled true` |
| `config get/show schema_pack` print the resolved pack | Scripts reading `config get schema_pack` (now the effective value, default `gbrain-base` when nothing is set, exit 0) | `gbrain schema active` | Read `~/.gbrain/config.json` directly for the file value |
| RLS check: plain Postgres → warn | Self-hosted Postgres with no PostgREST roles and a missing-RLS table (doctor no longer exits 1 for it) | `rls` (warn), docs/guides/rls-and-you.md | Create the PostgREST roles to get the fail verdict, or enable RLS |
| Migration ledger row | Hosts after a `--force-retry`, or with a skipped host migration (new warn) | `minions_migration` | Run `gbrain apply-migrations --yes` |
| Protected code pages withheld | Code files that literally contain a gbrain facts/takes fence marker (e.g. gbrain's own source) | `safe_index_pending` counts them as kept; `repair safe-chunks` residual `code_with_fence_marker` | None |
| Function `search_path` pinned | All Postgres/PGLite brains (no behavior change; ~10-15% more time per bulk fact insert through the withdrawal trigger in a 10k-row benchmark) | Supabase linter still lists the 3 fingerprint SQL functions (expected) | None |

## Numbers that change and why

- `minions_migration`: hosts that were `fail` after a forced retry become `warn` (pending), and hosts with a skipped migration gain a `warn`.
- `rls`: plain Postgres brains with a missing-RLS table move from `fail` to `warn`, which raises their doctor score.
- `extract_health`: the age suffix now reads "last halt Nd ago" and can be older than before.
- OAuth `expires_in` for clients with over-cap settings drops to 7776000.
