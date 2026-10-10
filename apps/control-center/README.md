# NAgex Control Center

Independent administrator control-plane app boundary.

This app is separate from the NAgex user product plane. It consumes admin-only
contracts/read models and must not be mounted into normal user workspace
navigation.

Canonical admin routes are defined in `src/control-center/control-center.ts`.

Local production-style start:

```powershell
npm run build
$env:HOST='127.0.0.1'
$env:PORT='4500'
$env:CONTROL_CENTER_ENV='TEST'
node apps/control-center/server.mjs
```

Admin API reads live under `/admin/api/*`. The public test shell uses only
privacy-safe deterministic certification data; privileged admin payloads require
`NAGEX_CONTROL_ADMIN_TOKEN`.
