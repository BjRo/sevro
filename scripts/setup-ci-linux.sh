#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y bubblewrap socat

# Ubuntu 24.04 confines unprivileged user namespaces unless bwrap has a profile.
if [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true)" == "1" ]]; then
  sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
  sudo systemctl reload apparmor
fi

# Fail before running cases if filesystem and network namespaces cannot start.
bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc \
  --unshare-user --unshare-pid --unshare-net -- /bin/true
