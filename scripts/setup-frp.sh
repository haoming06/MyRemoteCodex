#!/usr/bin/env bash

set -Eeuo pipefail

FRP_VERSION="0.71.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMP_DIR=""

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
My Remote Codex FRP setup

Server (Linux + systemd, run as root; Caddy must already be installed):
  sudo ./scripts/setup-frp.sh server \
    --frp-host frp.example.com \
    --base-domain remote.example.com \
    --device device-01

Local Mac (copy the server-generated client directory first):
  ./scripts/setup-frp.sh local --bundle ./my-remote-codex-device-01
  ./scripts/setup-frp.sh start

Commands:
  server   Install and configure frps, systemd, TLS, Caddy, and client credentials.
  local    Install frpc and create .env.frp from a server credential directory.
  download Download and verify one FRP v0.71.0 binary; optionally select the target platform.
  start    Start My Remote Codex using .env.frp.
  status   Show local configuration or server service status.
EOF
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

validate_hostname() {
  local value="$1"
  local name="$2"
  if [ ${#value} -gt 253 ] || ! [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || [[ "$value" == *..* ]]; then
    die "$name must be a valid DNS hostname"
  fi
}

validate_identifier() {
  local value="$1"
  local name="$2"
  if ! [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then
    die "$name must be a 1-64 character ASCII identifier"
  fi
}

validate_subdomain() {
  local value="$1"
  if ! [[ "$value" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
    die "device must be a lowercase DNS label"
  fi
}

validate_port() {
  local value="$1"
  local name="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    die "$name must be an integer between 1 and 65535"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

frp_asset() {
  local os="$1"
  local machine="$2"
  local arch=""
  local checksum=""

  case "$os:$machine" in
    Darwin:arm64)
      arch="arm64"
      checksum="45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6"
      ;;
    Darwin:x86_64)
      arch="amd64"
      checksum="1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637"
      ;;
    Linux:x86_64|Linux:amd64)
      arch="amd64"
      checksum="84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716"
      ;;
    Linux:aarch64|Linux:arm64)
      arch="arm64"
      checksum="f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266"
      ;;
    *)
      die "Unsupported platform: $os $machine"
      ;;
  esac

  printf '%s %s\n' "$arch" "$checksum"
}

install_frp_binary() {
  local binary_name="$1"
  local destination="$2"
  local requested_os="${3:-}"
  local requested_machine="${4:-}"
  local os
  local machine
  local arch
  local os_slug
  local expected_checksum
  local archive
  local extracted
  local actual_checksum

  os="${requested_os:-$(uname -s)}"
  machine="${requested_machine:-$(uname -m)}"
  read -r arch expected_checksum < <(frp_asset "$os" "$machine")
  case "$os" in
    Darwin) os_slug="darwin" ;;
    Linux) os_slug="linux" ;;
    *) die "Unsupported operating system: $os" ;;
  esac

  if [ -x "$destination" ] && [ "$("$destination" --version 2>/dev/null || true)" = "$FRP_VERSION" ]; then
    echo "$binary_name v$FRP_VERSION is already installed at $destination"
    return
  fi

  need_command curl
  need_command tar
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/my-remote-codex-frp.XXXXXX")"
  archive="$TEMP_DIR/frp.tar.gz"
  extracted="frp_${FRP_VERSION}_${os_slug}_${arch}"

  echo "Downloading official FRP v$FRP_VERSION for ${os}/${arch}..."
  curl --proto '=https' --tlsv1.2 --http1.1 --fail --location --retry 3 \
    --connect-timeout 15 --max-time 300 \
    "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${extracted}.tar.gz" \
    --output "$archive"

  actual_checksum="$(sha256_file "$archive")"
  if [ "$actual_checksum" != "$expected_checksum" ]; then
    die "FRP checksum mismatch (expected $expected_checksum, got $actual_checksum)"
  fi

  tar -xzf "$archive" -C "$TEMP_DIR"
  [ -x "$TEMP_DIR/$extracted/$binary_name" ] || die "$binary_name is missing from the FRP archive"
  install -m 0755 "$TEMP_DIR/$extracted/$binary_name" "$destination"
  [ "$("$destination" --version)" = "$FRP_VERSION" ] || die "Installed $binary_name has an unexpected version"

  rm -rf "$TEMP_DIR"
  TEMP_DIR=""
}

download_binary() {
  local binary_name="frpc"
  local output=""
  local target_os=""
  local target_arch=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --binary) binary_name="${2:-}"; shift 2 ;;
      --output) output="${2:-}"; shift 2 ;;
      --os) target_os="${2:-}"; shift 2 ;;
      --arch) target_arch="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown download option: $1" ;;
    esac
  done

  case "$binary_name" in
    frpc|frps) ;;
    *) die "--binary must be frpc or frps" ;;
  esac
  [ -n "$output" ] || die "--output is required"
  [ -d "$(dirname "$output")" ] || die "Output directory does not exist: $(dirname "$output")"
  if [ -n "$target_os" ] || [ -n "$target_arch" ]; then
    [ -n "$target_os" ] && [ -n "$target_arch" ] || die "--os and --arch must be provided together"
  fi
  install_frp_binary "$binary_name" "$output" "$target_os" "$target_arch"
  echo "Installed $binary_name v$FRP_VERSION at $output"
}

read_metadata() {
  local file="$1"
  local key="$2"
  local value
  value="$(awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$file")"
  [ -n "$value" ] || die "Missing $key in $file"
  printf '%s\n' "$value"
}

setup_server() {
  local frp_host=""
  local base_domain=""
  local device=""
  local frp_port="7000"
  local vhost_port="8080"
  local frp_dir="/etc/frp"
  local app_dir="/etc/my-remote-codex"
  local caddy_dir="/etc/caddy"
  local bundle_dir=""
  local client_host=""
  local gateway_token=""
  local caddyfile=""
  local caddy_snippet=""
  local caddy_backup=""
  local added_import="false"

  while [ $# -gt 0 ]; do
    case "$1" in
      --frp-host) frp_host="${2:-}"; shift 2 ;;
      --base-domain) base_domain="${2:-}"; shift 2 ;;
      --device) device="${2:-}"; shift 2 ;;
      --frp-port) frp_port="${2:-}"; shift 2 ;;
      --vhost-port) vhost_port="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown server option: $1" ;;
    esac
  done

  [ "$(id -u)" -eq 0 ] || die "server setup must be run as root"
  [ "$(uname -s)" = "Linux" ] || die "server setup supports Linux only"
  [ -n "$frp_host" ] || die "--frp-host is required"
  [ -n "$base_domain" ] || die "--base-domain is required"
  [ -n "$device" ] || die "--device is required"
  validate_hostname "$frp_host" "frp-host"
  validate_hostname "$base_domain" "base-domain"
  validate_subdomain "$device"
  validate_port "$frp_port" "frp-port"
  validate_port "$vhost_port" "vhost-port"

  need_command systemctl
  need_command openssl
  need_command caddy
  need_command install
  need_command grep
  [ -f "$caddy_dir/Caddyfile" ] || die "Expected Caddy config at $caddy_dir/Caddyfile"
  [ ! -e "$frp_dir/frps.toml" ] || die "$frp_dir/frps.toml already exists; refusing to overwrite it"

  client_host="$device.$base_domain"
  bundle_dir="/root/my-remote-codex-$device"
  [ ! -e "$bundle_dir" ] || die "$bundle_dir already exists; move or remove it before retrying"

  install -d -m 0755 /usr/local/bin
  install_frp_binary frps /usr/local/bin/frps
  umask 077
  install -d -m 0750 "$frp_dir" "$frp_dir/tls" "$frp_dir/secrets" "$app_dir" "$bundle_dir"

  openssl genrsa -out "$frp_dir/tls/ca.key" 4096 >/dev/null 2>&1
  openssl req -x509 -new -sha256 -days 3650 \
    -key "$frp_dir/tls/ca.key" \
    -subj "/CN=My Remote Codex FRP CA" \
    -out "$frp_dir/tls/ca.crt"
  openssl genrsa -out "$frp_dir/tls/server.key" 3072 >/dev/null 2>&1
  openssl req -new \
    -key "$frp_dir/tls/server.key" \
    -subj "/CN=$frp_host" \
    -out "$frp_dir/tls/server.csr"
  cat >"$frp_dir/tls/server.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$frp_host
EOF
  openssl x509 -req -sha256 -days 825 \
    -in "$frp_dir/tls/server.csr" \
    -CA "$frp_dir/tls/ca.crt" \
    -CAkey "$frp_dir/tls/ca.key" \
    -CAcreateserial \
    -extfile "$frp_dir/tls/server.ext" \
    -out "$frp_dir/tls/server.crt" >/dev/null 2>&1
  rm -f "$frp_dir/tls/server.csr" "$frp_dir/tls/server.ext" "$frp_dir/tls/ca.srl"

  openssl rand -hex 32 >"$frp_dir/secrets/frp-token"
  openssl rand -hex 32 >"$app_dir/gateway-token"
  gateway_token="$(tr -d '\r\n' <"$app_dir/gateway-token")"

  cat >"$frp_dir/frps.toml" <<EOF
bindAddr = "0.0.0.0"
bindPort = $frp_port
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = $vhost_port
subDomainHost = "$base_domain"

transport.tls.force = true
transport.tls.certFile = "$frp_dir/tls/server.crt"
transport.tls.keyFile = "$frp_dir/tls/server.key"

auth.method = "token"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "$frp_dir/secrets/frp-token"

maxPortsPerClient = 1
EOF
  chmod 0600 "$frp_dir/frps.toml" "$frp_dir/tls/ca.key" "$frp_dir/tls/server.key" \
    "$frp_dir/secrets/frp-token" "$app_dir/gateway-token"
  chmod 0644 "$frp_dir/tls/ca.crt" "$frp_dir/tls/server.crt"

  /usr/local/bin/frps verify -c "$frp_dir/frps.toml"

  cat >/etc/systemd/system/my-remote-codex-frps.service <<EOF
[Unit]
Description=My Remote Codex FRP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/frps -c $frp_dir/frps.toml
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=$frp_dir

[Install]
WantedBy=multi-user.target
EOF

  install -d -m 0755 "$caddy_dir/conf.d" /etc/systemd/system/caddy.service.d
  cat >"$app_dir/gateway.env" <<EOF
REMOTE_CODEX_GATEWAY_TOKEN=$gateway_token
EOF
  chmod 0600 "$app_dir/gateway.env"
  cat >/etc/systemd/system/caddy.service.d/my-remote-codex.conf <<EOF
[Service]
EnvironmentFile=$app_dir/gateway.env
EOF
  caddy_snippet="$caddy_dir/conf.d/my-remote-codex-$device.caddy"
  cat >"$caddy_snippet" <<EOF
$client_host {
    reverse_proxy 127.0.0.1:$vhost_port {
        header_up X-Remote-Codex-Gateway-Token {\$REMOTE_CODEX_GATEWAY_TOKEN}
    }
}
EOF
  caddy fmt --overwrite "$caddy_snippet"
  chmod 0644 "$caddy_snippet"
  REMOTE_CODEX_GATEWAY_TOKEN="$gateway_token" \
    caddy validate --config "$caddy_snippet" --adapter caddyfile
  caddyfile="$caddy_dir/Caddyfile"
  if ! grep -Eq "^[[:space:]]*import[[:space:]]+$caddy_dir/conf.d/\\*\\.caddy[[:space:]]*$" "$caddyfile"; then
    caddy_backup="$caddyfile.before-my-remote-codex"
    cp "$caddyfile" "$caddy_backup"
    printf '\nimport %s/conf.d/*.caddy\n' "$caddy_dir" >>"$caddyfile"
    added_import="true"
  fi
  if ! REMOTE_CODEX_GATEWAY_TOKEN="$gateway_token" \
    caddy validate --config "$caddyfile" --adapter caddyfile; then
    rm -f "$caddy_snippet"
    if [ "$added_import" = "true" ]; then
      cp "$caddy_backup" "$caddyfile"
    fi
    die "Caddy configuration validation failed; previous Caddyfile was restored"
  fi

  install -m 0600 "$frp_dir/secrets/frp-token" "$bundle_dir/frp-token"
  install -m 0600 "$app_dir/gateway-token" "$bundle_dir/gateway-token"
  install -m 0644 "$frp_dir/tls/ca.crt" "$bundle_dir/frp-ca.crt"
  cat >"$bundle_dir/metadata.env" <<EOF
FRP_VERSION=$FRP_VERSION
FRP_SERVER_ADDR=$frp_host
FRP_SERVER_PORT=$frp_port
FRP_SERVER_NAME=$frp_host
FRP_CLIENT_ID=$device
FRP_USER=selfhosted
FRP_SUBDOMAIN=$device
PUBLIC_URL=https://$client_host
EOF
  chmod 0600 "$bundle_dir/metadata.env"

  systemctl daemon-reload
  systemctl enable --now my-remote-codex-frps.service
  systemctl restart caddy

  echo
  echo "Server setup completed."
  echo "Public URL: https://$client_host"
  echo "Client credentials: $bundle_dir"
  echo
  echo "Next steps:"
  echo "  1. Point $frp_host and $client_host DNS records to this server."
  echo "  2. Allow inbound TCP 80, 443, and $frp_port in the cloud firewall."
  echo "  3. Copy the client directory to the Mac:"
  echo "     scp -r root@${frp_host}:$bundle_dir ."
  echo "  4. On the Mac, run:"
  echo "     ./scripts/setup-frp.sh local --bundle ./my-remote-codex-$device"
}

setup_local() {
  local bundle=""
  local env_file="$PROJECT_DIR/.env.frp"
  local config_dir="${HOME}/Library/Application Support/My Remote Codex/frp"
  local binary_dir="${HOME}/Library/Application Support/My Remote Codex/bin"
  local metadata=""
  local version=""
  local server_addr=""
  local server_port=""
  local server_name=""
  local client_id=""
  local user=""
  local subdomain=""
  local public_url=""
  local frpc_binary=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --bundle) bundle="${2:-}"; shift 2 ;;
      --env-file) env_file="${2:-}"; shift 2 ;;
      --config-dir) config_dir="${2:-}"; shift 2 ;;
      --binary-dir) binary_dir="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown local option: $1" ;;
    esac
  done

  [ "$(uname -s)" = "Darwin" ] || die "local setup supports macOS only"
  [ -n "$bundle" ] || die "--bundle is required"
  need_command awk
  need_command install
  bundle="$(cd "$bundle" 2>/dev/null && pwd)" || die "Bundle directory not found: $bundle"
  metadata="$bundle/metadata.env"
  for file in "$metadata" "$bundle/frp-token" "$bundle/gateway-token" "$bundle/frp-ca.crt"; do
    [ -f "$file" ] || die "Missing bundle file: $file"
    [ ! -L "$file" ] || die "Bundle files must not be symbolic links: $file"
  done

  version="$(read_metadata "$metadata" FRP_VERSION)"
  [ "$version" = "$FRP_VERSION" ] || die "Bundle requires unsupported FRP version: $version"
  server_addr="$(read_metadata "$metadata" FRP_SERVER_ADDR)"
  server_port="$(read_metadata "$metadata" FRP_SERVER_PORT)"
  server_name="$(read_metadata "$metadata" FRP_SERVER_NAME)"
  client_id="$(read_metadata "$metadata" FRP_CLIENT_ID)"
  user="$(read_metadata "$metadata" FRP_USER)"
  subdomain="$(read_metadata "$metadata" FRP_SUBDOMAIN)"
  public_url="$(read_metadata "$metadata" PUBLIC_URL)"
  validate_hostname "$server_addr" "FRP_SERVER_ADDR"
  validate_hostname "$server_name" "FRP_SERVER_NAME"
  validate_port "$server_port" "FRP_SERVER_PORT"
  validate_identifier "$client_id" "FRP_CLIENT_ID"
  validate_identifier "$user" "FRP_USER"
  validate_subdomain "$subdomain"
  [[ "$public_url" =~ ^https://[A-Za-z0-9.-]+$ ]] || die "PUBLIC_URL must be an HTTPS URL without a path"

  install -d -m 0700 "$config_dir" "$binary_dir"
  install -m 0600 "$bundle/frp-token" "$config_dir/frp-token"
  install -m 0600 "$bundle/gateway-token" "$config_dir/gateway-token"
  install -m 0644 "$bundle/frp-ca.crt" "$config_dir/frp-ca.crt"
  frpc_binary="$binary_dir/frpc-v$FRP_VERSION"
  install_frp_binary frpc "$frpc_binary"

  umask 077
  {
    printf 'REMOTE_CODEX_HOST=127.0.0.1\n'
    printf 'REMOTE_CODEX_FRP_ENABLED=true\n'
    printf 'REMOTE_CODEX_FRP_BINARY=%q\n' "$frpc_binary"
    printf 'REMOTE_CODEX_FRP_SERVER_ADDR=%q\n' "$server_addr"
    printf 'REMOTE_CODEX_FRP_SERVER_PORT=%q\n' "$server_port"
    printf 'REMOTE_CODEX_FRP_CLIENT_ID=%q\n' "$client_id"
    printf 'REMOTE_CODEX_FRP_USER=%q\n' "$user"
    printf 'REMOTE_CODEX_FRP_SUBDOMAIN=%q\n' "$subdomain"
    printf 'REMOTE_CODEX_FRP_TOKEN_FILE=%q\n' "$config_dir/frp-token"
    printf 'REMOTE_CODEX_FRP_GATEWAY_TOKEN_FILE=%q\n' "$config_dir/gateway-token"
    printf 'REMOTE_CODEX_FRP_TRUSTED_CA=%q\n' "$config_dir/frp-ca.crt"
    printf 'REMOTE_CODEX_FRP_SERVER_NAME=%q\n' "$server_name"
  } >"$env_file"
  chmod 0600 "$env_file"

  echo
  echo "Local FRP setup completed."
  echo "Configuration: $env_file"
  echo "Public URL: $public_url"
  echo
  echo "Start with: ./scripts/setup-frp.sh start"
}

start_local() {
  local env_file="$PROJECT_DIR/.env.frp"
  [ -f "$env_file" ] || die "$env_file is missing; run the local setup first"
  [ ! -L "$env_file" ] || die "$env_file must not be a symbolic link"
  set -a
  # The file is generated locally from validated values and contains no secret contents.
  source "$env_file"
  set +a
  cd "$PROJECT_DIR"
  exec npm start
}

show_status() {
  if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" -eq 0 ]; then
    systemctl --no-pager --full status my-remote-codex-frps.service
    systemctl --no-pager --full status caddy
    return
  fi
  local env_file="$PROJECT_DIR/.env.frp"
  if [ -f "$env_file" ]; then
    echo "Local FRP configuration: $env_file"
    grep -E '^(REMOTE_CODEX_FRP_SERVER_ADDR|REMOTE_CODEX_FRP_SERVER_PORT|REMOTE_CODEX_FRP_SUBDOMAIN|REMOTE_CODEX_FRP_BINARY)=' "$env_file"
  else
    die "$env_file is missing; run the local setup first"
  fi
}

command="${1:-}"
case "$command" in
  server) shift; setup_server "$@" ;;
  local) shift; setup_local "$@" ;;
  download) shift; download_binary "$@" ;;
  start) shift; [ $# -eq 0 ] || die "start does not accept options"; start_local ;;
  status) shift; [ $# -eq 0 ] || die "status does not accept options"; show_status ;;
  -h|--help|help|'') usage ;;
  *) die "Unknown command: $command" ;;
esac
