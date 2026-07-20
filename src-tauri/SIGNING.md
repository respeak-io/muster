# Signing Muster

Three independent "signings" — do **not** conflate them:

1. **Updater signing (minisign)** — `TAURI_SIGNING_PRIVATE_KEY`. Signs the auto-update
   artifacts so an installed app trusts the update it downloads. The public key is baked
   into `tauri.conf.json`; the matching private key lives in CI secrets. **Not** Azure,
   **not** from Tim. This is the thing that blocks a **local** `tauri build` (because
   `createUpdaterArtifacts: true`) — see *Local build* below.

2. **Windows code-signing (Azure Trusted Signing)** — the Respeak GmbH Azure profile.
   Removes the SmartScreen "Unbekannter Herausgeber" warning. Reuses the **same account +
   certificate profile already set up for pii-reduction (Schwärzwerk)** — see
   `pii-reduction/installer/SIGNING.md`. Values come from Tim. **Windows only.**

3. **macOS code-signing + notarization (Apple Developer ID)** — a **separate** Apple
   account (~99 $/yr). The Azure profile **cannot** sign macOS binaries. Notarization sits
   **on top of** Developer ID signing (Apple malware-scan + a stapled ticket); it does not
   replace signing. Not configured yet — Muster is ad-hoc signed (`signingIdentity: "-"`)
   and users clear quarantine with `xattr` (see the release notes in `release.yml`).

## Windows — activate Azure Trusted Signing

Needed from Tim (Azure account admin), identical to `pii-reduction/installer/SIGNING.md`:

- Trusted Signing **account name**, **certificate profile name**, and **region endpoint**
  (`weu` = West Europe, `neu` = North Europe).
- A **service principal** (App Registration) holding the built-in role **"Trusted Signing
  Certificate Profile Signer"**, scoped to the account or profile. Creating the profile is
  not enough — without this role signing returns **403**. It yields `AZURE_TENANT_ID` /
  `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`.

### Create the service principal (least-privilege, one-time)

Run as an Azure user who can create app registrations and assign roles on the signing
account. The SP gets exactly **one role** on exactly the signing account — no
subscription-wide access, nothing else in the tenant.

```bash
az login
az account set --subscription "<SUBSCRIPTION_ID>"

# Scope = the Trusted Signing ACCOUNT (holds the Respeak GmbH profile that already signs
# Schwärzwerk — one profile signs both products, so one SP covers both).
SCOPE=$(az resource show -g "<RESOURCE_GROUP>" -n "<SIGNING_ACCOUNT>" \
  --resource-type "Microsoft.CodeSigning/codeSigningAccounts" --query id -o tsv)

# Create the SP AND assign only the signer role at that scope, in one shot.
az ad sp create-for-rbac \
  --name "muster-ci-signer" \
  --role "Trusted Signing Certificate Profile Signer" \
  --scopes "$SCOPE"
```

The one-time output maps to the three GitHub secrets:

| `az` output | GitHub repo secret |
| --- | --- |
| `appId`    | `AZURE_CLIENT_ID` |
| `tenant`   | `AZURE_TENANT_ID` |
| `password` | `AZURE_CLIENT_SECRET` |

```bash
gh secret set AZURE_CLIENT_ID     --body "<appId>"
gh secret set AZURE_TENANT_ID     --body "<tenant>"
gh secret set AZURE_CLIENT_SECRET --body "<password>"
```

Notes:
- **Tightest scope** (profile, not account): grab the certificate profile's *Resource ID*
  from the portal (profile → JSON/Properties) and pass it as `$SCOPE` instead.
- If the role name errors it may be the renamed **"Artifact Signing Certificate Profile
  Signer"** — find the exact string with
  `az role definition list --query "[?contains(roleName,'Signing')].roleName" -o tsv`.
- `create-for-rbac`'s secret defaults to a **1-year expiry** → rotate before it lapses
  (`az ad app credential reset --id <appId>`), or drop the stored secret entirely with
  **GitHub OIDC**: `az ad app federated-credential create` for the repo + `azure/login@v2`
  federated auth, which `DefaultAzureCredential` picks up automatically.

Then:

1. Fill in `src-tauri/tauri.signing.conf.json` with the account / profile / region.
2. Add `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` as GitHub **repo
   secrets**.
3. Done. `release.yml` auto-detects `AZURE_CLIENT_ID`: when present it installs the signing
   CLI and merges `tauri.signing.conf.json` via `--config`, so tauri-action signs the app
   `.exe`, the NSIS setup, and the `.msi`. Until that secret exists, releases build
   **unsigned exactly as before** — nothing else has to change.

Tool: `signCommand` calls `trusted-signing-cli` (`cargo install trusted-signing-cli`).
Tauri's docs may refer to the equivalent as `artifact-signing-cli` — verify the exact
binary name / install at setup and adjust `tauri.signing.conf.json` + the install step in
`release.yml` if needed. It reads the `AZURE_*` env for auth and signs each artifact (`%1`)
with a mandatory RFC3161 timestamp (Trusted Signing certs are valid only ~3 days; the
timestamp keeps the signature valid permanently). Alternative, if the CLI is fussy:
Microsoft's `signtool` + `Azure.CodeSigning.Dlib.dll` + a `metadata.json`, exactly the way
`pii-reduction/build_exe.ps1` does it.

> The CI wiring is inert until the Azure secret exists, so it can't be verified until then —
> confirm on the first real signed tag that the `--config` overlay is picked up and
> `signtool verify` / the CLI reports success.

After signing works, drop the "isn't code-signed / SmartScreen may warn" line from the
Windows section of `releaseBody` in `release.yml`.

## macOS — separate track (not done)

Would need an Apple **Developer ID Application** cert + **notarization** (both, not either):
set `bundle.macOS.signingIdentity` to the Developer ID, and give tauri-action
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific
password), `APPLE_TEAM_ID`. Own decision, own account — the Azure profile does not help here.

## Local build (no Azure / Tim values needed)

The only blocker for a local `tauri build` is the updater key (#1). Generate a throwaway one:

```powershell
npm run tauri signer generate -- -w $env:USERPROFILE\.tauri\muster_test.key -p ""
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:USERPROFILE\.tauri\muster_test.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build
```

A throwaway key means the produced updater `.sig` won't verify against real releases — fine
for just building and running the app locally. Use the real CI secret for an actual release.
