# Deploy configuration

The three files here live **only on the production server** and are not installed by any
package or script. Before this directory existed, rebuilding the box meant losing all three.
They are committed so the instance is reproducible.

Production runs on a single `t3.micro` (Ubuntu 24.04, `ap-south-1`) behind Nginx, with the
Next.js frontend on Vercel. Redis and RabbitMQ are local to the box and bound to loopback.

| File | Installs to |
|---|---|
| `ecosystem.config.cjs` | `~/apps/backend/ecosystem.config.cjs` |
| `nginx/skein.conf` | `/etc/nginx/sites-available/skein` |
| `systemd/wait-for-deps.conf` | `/etc/systemd/system/pm2-ubuntu.service.d/wait-for-deps.conf` |

**Not here, by design:** the three `.env` files (`user/`, `chat/`, `mail/`). They hold live
credentials and this repository is public. Keep them in a password manager.

## Installing on a fresh box

### PM2

```bash
cp deploy/ecosystem.config.cjs ~/apps/backend/ecosystem.config.cjs
cd ~/apps/backend && pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

`pm2 startup` prints a `sudo env PATH=... ` command — run it, then `pm2 save` again.

Each app sets `cwd` to its own service directory. That is load-bearing: every service loads
its own `.env` through dotenv relative to the working directory.

### Nginx

`skein.conf` is committed **as it runs**, which means it includes the `# managed by Certbot`
lines. Those reference certificates that do not exist on a fresh box, so Nginx will fail to
start if you install this file verbatim before issuing them.

On a rebuild, strip the Certbot-managed lines first, install, then let Certbot add them back:

```bash
grep -v 'managed by Certbot' deploy/nginx/skein.conf | sudo tee /etc/nginx/sites-available/skein
sudo ln -sf /etc/nginx/sites-available/skein /etc/nginx/sites-enabled/skein
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d skein-user.duckdns.org -d skein-chat.duckdns.org
```

Removing the `default` site matters — it owns `listen 80 default_server` and will answer
requests meant for these hostnames.

Two details worth not "tidying up":

- **Two hostnames, not one host with path prefixes.** The Socket.IO client reads a path in its
  connect URL as a *namespace*, so `https://host/chat` would silently never connect.
- **`client_max_body_size 15m` on the chat block.** Nginx defaults to 1m and returns 413 before
  Express sees the request, which breaks image upload for most phone photos.

### systemd drop-in

```bash
sudo mkdir -p /etc/systemd/system/pm2-ubuntu.service.d
sudo cp deploy/systemd/wait-for-deps.conf /etc/systemd/system/pm2-ubuntu.service.d/
sudo systemctl daemon-reload
```

Install this *after* `pm2 startup` has created `pm2-ubuntu.service`.

## Access

SSH depends on both a key file and a source-IP allowance in the security group, and both have
been lost before. `SkeinSSMRole` (`AmazonSSMManagedInstanceCore`) is attached to the instance,
so **Systems Manager → Session Manager** works from the console with neither. Keep it attached.
