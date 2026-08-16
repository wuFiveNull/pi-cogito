# Cogito gateway service

`cogito-proactive.service` and `cogito-drift.service` run the
three-process proactive/drift daemons (packages/proactive + packages/drift).

- proactive daemon: polls sources, judges candidates, delivers, and writes the
  drift gate (drift.db) each tick.
- drift daemon: reads the gate (TTL), schedules via drift drive, and executes
  one SKILL per tick while idle.

Both require host model/auth config (`~/.cogito/agent/auth.json` + `models.json`)
and run `node --import tsx` from the repo. Install like the gateway service:

```bash
install -d -m 700 ~/.config/systemd/user
install -m 644 systemd/cogito-proactive.service systemd/cogito-drift.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cogito-proactive.service cogito-drift.service
loginctl enable-linger "$USER"
```

# Cogito gateway service

`cogito-gateway.service` runs the configured channels continuously as a
user service. It restarts on failures, waits up to 90 seconds for a graceful
stop, and uses a mode-`0600` environment file for the Web management token.

The service binds the management Web channel to `127.0.0.1:8787`. `/api/health`
is a public liveness endpoint; `/api/status`, `/api/metrics`, and `/metrics`
require `Authorization: Bearer <GATEWAY_WEB_AUTH_TOKEN>`.

Install it for the current user:

```bash
install -d -m 700 ~/.config/cogito ~/.config/systemd/user
install -m 644 systemd/cogito-gateway.service ~/.config/systemd/user/
umask 077
printf 'PATH=%s:/usr/local/bin:/usr/bin\n' "$(dirname "$(command -v node)")" > ~/.config/cogito/gateway.env
printf 'GATEWAY_WEB_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)" >> ~/.config/cogito/gateway.env
systemctl --user daemon-reload
systemctl --user enable --now cogito-gateway.service
loginctl enable-linger "$USER"
```

Check the live state without exposing the token:

```bash
systemctl --user status cogito-gateway.service
journalctl --user -u cogito-gateway.service -f
cat ~/.cogito/agent/channel-gateway-ready.json
```
