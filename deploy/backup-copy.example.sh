#!/bin/bash
# Install as /usr/local/sbin/jader-market-backup-copy, owned by root, mode 0700.
set -euo pipefail
# Protected configuration defines JADER_BACKUP_REMOTE, e.g. vault:bucket/jader.
# Rclone credentials live separately in /etc/jader-market/rclone.conf (0600).
source /etc/jader-market/backup-copy.env
archive="$1"
name="${archive##*/}"
[[ "$name" =~ ^backup-[0-9]{13}-[a-f0-9]{16}\.jmb$ ]]
: "${JADER_BACKUP_REMOTE:?Set a dedicated off-host destination}"
target="${JADER_BACKUP_REMOTE%/}/$name"
/usr/bin/rclone --config /etc/jader-market/rclone.conf copyto --immutable "$archive" "$target"
# Compare every encrypted byte read back from remote storage before success.
/usr/bin/rclone --config /etc/jader-market/rclone.conf cat "$target" | /usr/bin/cmp --silent "$archive" -
