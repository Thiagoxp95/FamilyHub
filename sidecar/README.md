# FamilyHub Parakeet sidecar

Always-on local ASR for the "James" wake word and post-wake capture. Apple
Silicon only (uses MLX).

## Setup

```bash
cd sidecar
./setup.sh
```

This creates `sidecar/.venv`. The Electron main process auto-discovers
`sidecar/.venv/bin/python` and `sidecar/parakeet_listener.py`. Override with
`FAMILYHUB_SIDECAR_PYTHON` / `FAMILYHUB_SIDECAR_SCRIPT`.

## Smoke test

```bash
printf '%s\n' "$(python3 -c 'import base64,sys; sys.stdout.write(base64.b64encode(bytes(3200)).decode())')" \
  | ./.venv/bin/python parakeet_listener.py
```

Expected: at least one JSON line on stdout, beginning with the ready signal
`{"type": "partial", "text": "", "words": []}`.
