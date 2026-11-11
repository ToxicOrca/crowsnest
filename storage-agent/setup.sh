#!/usr/bin/env bash
# Crowsnest ZFS storage agent installer. Run with sudo on the ZFS host.
# Root is needed only to create the service user, write under /opt and /etc,
# and register the systemd unit; the agent itself runs unprivileged.
set -euo pipefail
umask 077
if [[ $# -gt 0 ]]; then
    echo 'Usage: sudo bash crowsnest-storage-setup.sh' >&2
    exit 1
fi
# Optional staging prefix (empty on a real host); paths below are absolute under it.
root="${CROWSNEST_STORAGE_ROOT:-}"
if [[ -n "$root" && "$root" != /* ]]; then
    echo 'CROWSNEST_STORAGE_ROOT must be an absolute path.' >&2
    exit 1
fi
user=crowsnest-storage
app="$root/opt/crowsnest-storage"
etc="$root/etc/crowsnest-storage"
unit="$root/etc/systemd/system/crowsnest-storage.service"
if [[ "$(id -u)" != 0 ]]; then
    echo 'Run with sudo: setup creates a system user, files under /opt and /etc, and a systemd unit.' >&2
    exit 1
fi
for path in "$app" "$etc" "$unit"; do
    if [[ -e "$path" || -L "$path" ]]; then
        echo "Already exists; refusing to overwrite: $path" >&2
        exit 1
    fi
done
if id -u "$user" >/dev/null 2>&1; then
    echo "User $user already exists. Inspect the existing installation before continuing." >&2
    exit 1
fi
if [[ ! -x /usr/bin/python3 ]] || ! /usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
    echo 'Python 3.9 or newer is required at /usr/bin/python3 (standard library only).' >&2
    exit 1
fi
command -v zpool >/dev/null || { echo 'zpool was not found. Install OpenZFS 2.3 or newer first.' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'systemd is required to run the storage agent.' >&2; exit 1; }
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$user"
mkdir -p -- "$(dirname -- "$app")" "$(dirname -- "$etc")" "$(dirname -- "$unit")"
mkdir -m 0755 -- "$app"
cd -- "$app"
__WRITE_FILES__
# Device names are keyed by a salt generated here; it never leaves this host,
# and the dashboard never sees it. Keep storage.json to keep names stable.
/usr/bin/python3 -I -c '
import json, secrets, sys
with open(sys.argv[1]) as source:
    config = json.load(source)
if "nameSalt" in config:
    sys.exit("storage.json already contains a name salt")
config["nameSalt"] = secrets.token_hex(32)
with open(sys.argv[1], "w") as target:
    json.dump(config, target, indent=2)
    target.write("\n")
' storage.json
mkdir -m 0750 -- "$etc"
mv -- storage.json "$etc/storage.json"
mv -- crowsnest-storage.service "$unit"
chmod 0644 crowsnest_storage.py "$unit"
chmod 0600 "$etc/storage.json"
chown root:root -- "$app" crowsnest_storage.py "$unit"
chown "root:$user" -- "$etc"
chown "$user:$user" -- "$etc/storage.json"
# Prove read access as the unprivileged service user before anything is enabled.
if ! runuser -u "$user" -- /usr/bin/python3 -I "$app/crowsnest_storage.py" --check; then
    echo "The $user account cannot read ZFS status (check: ls -l /dev/zfs)." >&2
    echo "Files are retained for inspection. Do not run the agent as root; see the configuration guide." >&2
    exit 1
fi
if [[ "${CROWSNEST_PREPARE_ONLY:-0}" == 1 ]]; then
    printf '\nStorage agent files prepared:\n  %s\n  %s\n  %s\n' "$app/crowsnest_storage.py" "$etc/storage.json" "$unit"
    printf 'Review them, then run: sudo systemctl daemon-reload && sudo systemctl enable --now crowsnest-storage\n'
    exit 0
fi
systemctl daemon-reload
if ! systemctl enable --now crowsnest-storage; then
    echo "Startup failed. Files are retained; check: journalctl -u crowsnest-storage" >&2
    exit 1
fi
printf '\nStorage agent installed and started as %s.\n' "$user"
printf 'Check reports with: sudo journalctl -u crowsnest-storage -f\n'
