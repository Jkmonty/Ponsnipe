#!/usr/bin/env bash
#
# Ponsnipe, from a bare Ubuntu server to a live site.
#
# Run once on a fresh box:
#
#     sudo bash setup.sh                  # serve on the server's IP, plain HTTP
#     sudo bash setup.sh ponsnipe.com     # serve on a domain, with real TLS
#
# Safe to run again: every step checks before it acts, so a second run after a
# failure picks up where the first stopped rather than doubling anything.
#
# What it deliberately does NOT do is put a wallet on this machine. The server
# runs in PUBLIC_MODE, which serves the feed and refuses every route that could
# move funds. Trading happens in the visitor's own browser with a key this
# server never sees, and that stays true because there is no key here to leak.

set -euo pipefail

#
# A dropped terminal must not abandon a half-finished deploy.
#
# The build saturates both cores for half a minute, and Docker rewrites
# iptables when it recreates containers, either of which can take an SSH
# session with it. Ignoring SIGHUP means the deploy runs to the end whatever
# happens to the connection that started it.
#
trap '' HUP

REPO="https://github.com/Jkmonty/Ponsnipe.git"
APP_DIR="/opt/ponsnipe"

#
# The domain, remembered between runs.
#
# It used to come only from the argument, and the script's own closing message
# tells you to update with `sudo bash setup.sh` — with no argument. After
# setting up HTTPS once, that update would rewrite the Caddyfile back to plain
# :80 and silently drop the certificate. So a domain given once is kept, and
# `none` is how you deliberately go back to HTTP.
#
DOMAIN_FILE="$APP_DIR/.domain"
DOMAIN="${1:-}"
if [ "$DOMAIN" = "none" ]; then
  DOMAIN=""
  rm -f "$DOMAIN_FILE"
elif [ -z "$DOMAIN" ] && [ -f "$DOMAIN_FILE" ]; then
  DOMAIN="$(cat "$DOMAIN_FILE")"
fi

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[0;32m✓\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo bash setup.sh ${DOMAIN}" >&2
  exit 1
fi

# ── 1. packages ───────────────────────────────────────────────────────────
say "Updating the system"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw >/dev/null
ok "base packages installed"

# ── 2. swap ───────────────────────────────────────────────────────────────
# Building Next.js is the most memory-hungry thing this box ever does. 4GB is
# enough, but a swap file turns "the build was killed and you have no idea why"
# into "the build was slow", which is a much better failure.
if [ ! -f /swapfile ]; then
  say "Adding 2GB of swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap on"
else
  ok "swap already present"
fi

# ── 3. docker ─────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
  ok "docker installed"
else
  ok "docker already installed"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ── 4. firewall ───────────────────────────────────────────────────────────
# SSH is allowed BEFORE the firewall is switched on. Enabling ufw without that
# line is the classic way to lock yourself out of a server you just bought.
say "Setting up the firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ok "ports 22, 80 and 443 open; everything else closed"

# ── 5. the code ───────────────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  say "Updating Ponsnipe"
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" reset --hard --quiet origin/master
else
  say "Fetching Ponsnipe"
  rm -rf "$APP_DIR"
  git clone --quiet --depth 1 "$REPO" "$APP_DIR"
fi
ok "code at $(git -C "$APP_DIR" rev-parse --short HEAD)"

# Untracked, so the `git reset --hard` above leaves it alone.
if [ -n "$DOMAIN" ]; then
  printf '%s' "$DOMAIN" > "$DOMAIN_FILE"
fi

# ── 6. the reverse proxy ──────────────────────────────────────────────────
# With a domain, Caddy fetches and renews a Let's Encrypt certificate by itself.
# Without one, it serves plain HTTP on the IP — fine for a first look, and the
# reason to point a domain here before showing anyone.
say "Configuring the web server"
if [ -n "$DOMAIN" ]; then
  cat > "$APP_DIR/deploy/Caddyfile" <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy app:3000 {
		# The feed holds a Server-Sent Events connection open per viewer. The
		# default two-minute idle timeout would cut every one of them.
		flush_interval -1
		transport http {
			read_timeout 24h
		}
	}
}
EOF
  ok "serving https://$DOMAIN with an automatic certificate"
else
  cat > "$APP_DIR/deploy/Caddyfile" <<'EOF'
:80 {
	encode zstd gzip
	reverse_proxy app:3000 {
		flush_interval -1
		transport http {
			read_timeout 24h
		}
	}
}
EOF
  ok "serving plain HTTP on this server's IP (no domain given)"
fi

# ── 7. build and run ──────────────────────────────────────────────────────
say "Building and starting (first build takes 3-5 minutes)"
cd "$APP_DIR/deploy"
docker compose up -d --build

#
# Make Caddy read the Caddyfile it was just handed.
#
# The Caddyfile is a bind mount, so writing a new one does not change the
# container's spec and `up -d` leaves Caddy running with whatever it started
# with. Setting a domain therefore appeared to work — the file said
# ponsnipe.com, the script said https — while Caddy was still serving :80 and
# had never asked for a certificate.
#
# A reload rather than a restart: it swaps the config in place with no dropped
# connections, which matters for the feed's open event streams.
#
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile   || docker compose restart caddy

#
# Keep the build cache from growing without limit.
#
# Measured at 9.2GB after a few weeks of deploys, of which 8.8GB was
# reclaimable — harmless on a 96GB disk right up until it is not, and nothing
# else on this box ever prunes it. Two gigabytes is enough to keep the layers
# that make the next build fast.
#
docker builder prune --force --keep-storage 2GB >/dev/null 2>&1 || true

say "Done"
IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo 'this server')"
if [ -n "$DOMAIN" ]; then
  echo "    Ponsnipe is starting at https://$DOMAIN"
  echo "    If it does not answer, check that $DOMAIN has an A record pointing to $IP."
else
  echo "    Ponsnipe is starting at http://$IP"
  echo "    Re-run with a domain to get HTTPS:  sudo bash setup.sh yourdomain.com"
  echo "    The domain is remembered, so later updates need no argument."
fi
echo
echo "    The feed needs a minute or two to index before it fills up."
echo "    Watch it:    docker compose -f $APP_DIR/deploy/docker-compose.yml logs -f app"
echo "    Update it:   sudo bash $APP_DIR/deploy/setup.sh"
