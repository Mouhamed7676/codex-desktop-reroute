# Codex desktop, rerouted

Runs a standalone copy of the Codex desktop app against a local Responses->Chat
bridge, so turns go to NVIDIA NIM instead of OpenAI. The real
`C:\Users\ANIS\.codex` and the installed app in `WindowsApps` are never touched.

## Start it

Double-click **`start.cmd`**, or from PowerShell:

```powershell
cd C:\Users\ANIS\Desktop\caaaa\codex-crack
.\run.ps1 -Provider nvidia
```

That does three things in order:

1. reads the NVIDIA key from `secrets.json`
2. starts `adapter\responses-adapter.mjs` on `127.0.0.1:8787` and waits for `/health`
3. launches `CodexApp\ChatGPT.exe` with `CODEX_HOME` pointed at `codex-home\`

Close the app window to stop everything; `run.ps1` kills the bridge on exit.

## Don't

- Don't launch `CodexApp\ChatGPT.exe` by itself. Without `CODEX_HOME` and the
  bridge it will try the real OpenAI backend and hit plan limits.
- Don't point the installed `WindowsApps` shortcut at this; it has no write
  access and its own config.

## What goes where

| Path | Role |
| --- | --- |
| `run.ps1` | launcher: key, bridge, app |
| `start.cmd` | double-click wrapper for `run.ps1` |
| `providers.json` | upstream presets (`nvidia`, `opencode`) |
| `secrets.json` | API keys, keyed by preset name |
| `adapter\responses-adapter.mjs` | Responses API -> Chat Completions bridge |
| `adapter\adapter.log` | one line per upstream call: model, items, tokens |
| `codex-home\config.toml` | private Codex config (`model_provider = "bridge"`) |
| `codex-home\model-catalog.json` | 85 NVIDIA model ids shown in the picker |
| `codex-home\sessions\` | imported + new chat rollouts |
| `CodexApp\` | standalone app copy (2.3 GB) |
| `tools\` | asar helpers, catalog builder, history importer |
| `.tmp\` | scratch, screenshots, pre-import DB backups |

## Models

The picker lists every id from the account's `/v1/models` (85 entries). Only
these answer 200 on the current free key:

- `nvidia/nemotron-3.5-lightning-30b-a3b` (default, fast)
- `nvidia/nemotron-3.5-super-vl-120b-a12b`
- `nvidia/nemotron-3-ultra-550b-a55b` (slow, biggest)

Anything else in the list returns `404 Function ... Not found for account`.
Picking a model passes its id straight to NVIDIA; `run.ps1` builds the map from
the active catalog, and `"*"` is only the fallback for ids not in the catalog.

## Larp mode

```powershell
.\run.ps1 -Provider nvidia -Larp
```

or double-click **`start-larp.cmd`**.

The picker switches to genuine OpenAI catalog entries — `GPT-6-Astra`,
`GPT-6-Sol`, `GPT-6-Luna`, `GPT-5.6-Sol`, `GPT-5.6-Terra`, `GPT-5.6-Luna`,
`GPT-5.5`, `GPT-5.4` — with their real instructions and reasoning levels. Every
one of them resolves to an NVIDIA model at the bridge. The UI says GPT, the wire
says nemotron.

| Picker says | Actually runs |
| --- | --- |
| `gpt-6-astra`, `gpt-6-sol` | `nvidia/nemotron-3-ultra-550b-a55b` |
| `gpt-6-luna`, `gpt-5.6-sol` | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4` | `nvidia/nemotron-3.5-lightning-30b-a3b` |

Mapping lives in `larp.json`; rebuild the catalog after editing it:

```powershell
node tools\build-larp-catalog.mjs .tmp\catalog.json larp.json catalogs\larp.json catalogs\larp-map.json
```

`run.ps1` copies the selected catalog over `codex-home\model-catalog.json` and
rewrites the `model` / `model_catalog_json` lines in `codex-home\config.toml`
before every launch, so the two modes never fight.

Proof it is lying to you correctly, from `adapter\adapter.log`:

```
ok model=nvidia/nemotron-3.5-super-vl-120b-a12b items=1 tokens=54   <- asked for gpt-6-luna
```


## Regenerate the catalog

```powershell
# one id per line
curl.exe -s -H "Authorization: Bearer $env:NVIDIA_API_KEY" `
  https://integrate.api.nvidia.com/v1/models |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.map(m=>m.id).join('\n')))" `
  > .tmp\nvidia-models.txt

node tools\build-catalog.mjs .tmp\catalog.json codex-home\model-catalog.json --models .tmp\nvidia-models.txt
```

`.tmp\catalog.json` must exist first — it is the output of:

```powershell
$env:CODEX_HOME = "$PWD\codex-home"; codex debug models > .tmp\catalog.json
```

## Import history again

```powershell
node tools\import-history.mjs "C:\Users\ANIS\.codex" "$PWD\codex-home"
```

Idempotent: `INSERT OR IGNORE`, existing rows win, nothing is deleted. It
rewrites imported threads to `model_provider = "bridge"` so resumed chats use
the adapter. Backups from the last run: `.tmp\state_5.pre-import.sqlite`,
`.tmp\thread_history_1.pre-import.sqlite`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `bridge did not come up on port 8787` | stale adapter still listening | `Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| ? CommandLine -like '*responses-adapter*' \| % { Stop-Process -Id $_.ProcessId -Force }` |
| Turns 401 | key missing/expired | put a fresh key in `secrets.json` under `nvidia`, restart |
| Turns 404 `Function ... Not found` | model not provisioned on the free key | pick one of the three live models |
| Raw `<function.exec>` in chat | adapter XML recovery missed a shape | check `adapter\adapter.log`, then `.tmp\` for the last request body |
| Picker empty / only OpenAI models | `model_catalog_json` missing from config | re-add the line in `codex-home\config.toml` |
| App opens signed out | `codex-home\auth.json` missing | copy `C:\Users\ANIS\.codex\auth.json` into `codex-home\` |

## OpenCode lane

`.\run.ps1 -Provider opencode` exists but free models return
`FreeUsageLimitError 429` through the API — the free tier is app-only. It works
with a paid Zen model; put the key in `secrets.json` under `opencode` and set
`providers.json` -> `opencode.model` to that model id.
