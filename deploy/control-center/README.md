# NAgex Control Center Test Deployment

Target public hostname: `https://control-test.agex.site`

The Control Center is an independent admin app in `apps/control-center`, served
on loopback only and exposed through the existing Cloudflare Tunnel.

Deployment checklist:

1. Confirm `ss -ltnp | grep ':4500'` is empty. If occupied, choose the next
   unused loopback port and update the service and tunnel ingress together.
2. Build from `/home/redcloud/services/nagex/source` with `npm run build`.
3. Install `deploy/control-center/nagex-control.service` as
   `/etc/systemd/system/nagex-control.service`.
4. Create `/etc/nagex/control-center.env` from the template without committing
   or printing the token.
5. Run `sudo systemctl daemon-reload`, `sudo systemctl enable
   nagex-control.service`, and `sudo systemctl restart nagex-control.service`.
6. Verify `curl -I http://127.0.0.1:4500/` and
   `curl http://127.0.0.1:4500/admin/api/health`.
7. Add only `control-test.agex.site -> http://127.0.0.1:4500` to the existing
   Cloudflare Tunnel ingress configuration.
8. Route DNS to the tunnel using the established Cloudflare method.
9. Verify HTTPS returns the NAgex Control Center TEST shell and does not expose
   raw user content, API keys, admin tokens, or user-app session cookies.
