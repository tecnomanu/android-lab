#!/usr/bin/env bash
# End-to-end smoke test: exercises every command against a real device.
#
# Unlike `npm test`, this one boots Android, so it is slow and needs a host that
# can actually run a backend. It uses a throwaway device and cleans up after
# itself, so it will not touch anything you already have running.
#
#   test/smoke.sh                       # whatever backend doctor picks
#   CLI=android-lab test/smoke.sh       # against an installed build
#   BACKEND=redroid test/smoke.sh       # force one
set -u

CLI="${CLI:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/android-lab.js}"
DEV="${DEV:-smoke-test}"
BE="${BACKEND:-}"
[ -n "$BE" ] && CLI="$CLI --backend $BE"

PASS=0; FAIL=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31m✗\033[0m %s\n     %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

check() { # name, expected-pattern, command...
  local name="$1" want="$2"; shift 2
  local out; out=$("$@" 2>&1)
  if echo "$out" | grep -qE "$want"; then ok "$name"; else bad "$name" "$(echo "$out" | head -2 | tr '\n' ' ')"; fi
}

HOST_ABI=$(uname -m)   # x86_64 or arm64/aarch64; the guest image follows the host
case "$HOST_ABI" in arm64|aarch64) WANT_ABI='arm64-v8a';; *) WANT_ABI='x86_64';; esac

echo "== informational =="
check "--version"            '^[0-9]+\.[0-9]+\.[0-9]+' $CLI --version
check "--help"               'android-lab'             $CLI --help
check "help"                 'usage'                   $CLI help
check "doctor"               'selected backend'        $CLI doctor
check "list"                 'NAME|no devices'         $CLI list
check "ls alias"             'NAME|no devices'         $CLI ls
check "list --json"          '^\[|\[\]'                $CLI list --json
check "status"               'backend'                 $CLI status
check "status --json"        '"backend"'               $CLI status --json
check "update --check-only"  'android-lab|npm'         $CLI update --check-only

echo "== errors must fail cleanly =="
check "unknown command"      'unknown command'         $CLI nonsense
check "unknown backend"      'unknown backend'         $CLI status --backend nope
check "clean refuses without a tty" 'cancelled'        sh -c "$CLI clean --name $DEV < /dev/null"
# redroid only exists on Linux with binder; everywhere else it must say so.
if [ "$(uname -s)" != "Linux" ]; then
  check "redroid rejected off Linux" 'binder'          $CLI start --backend redroid
fi

echo "== lifecycle on a throwaway device =="
check "setup --yes"          'boot_completed|done'     $CLI setup --yes --name $DEV
check "appears in list"      "$DEV"                    $CLI list
check "status"               'running'                 $CLI status --name $DEV
check "shell one-shot"       '^[0-9]+$'                $CLI shell --name $DEV getprop ro.build.version.release
# /system always has content; a fresh device's /data/local/tmp does not.
check "shell with a pipe"    'bin|etc|lib'               $CLI shell --name $DEV "ls /system | head -5"
check "adb passthrough"      "$WANT_ABI"               $CLI adb --name $DEV -- shell getprop ro.product.cpu.abi
check "screen --shot"        'screenshot ->'           $CLI screen --shot --name $DEV
check "logs"                 '.'                       sh -c "$CLI logs --name $DEV 2>&1 | head -3"

echo "== persistence =="
$CLI shell --name $DEV "echo smoke-ok > /data/local/tmp/smoke.txt" >/dev/null 2>&1
$CLI stop --name $DEV >/dev/null 2>&1
$CLI start --name $DEV >/dev/null 2>&1
check "survives stop/start"  'smoke-ok'                $CLI shell --name $DEV "cat /data/local/tmp/smoke.txt"

echo "== cleanup =="
check "clean --yes"          'wiped'                   $CLI clean --yes --name $DEV
check "clean --remove"       'removed'                 $CLI clean --remove --yes --name $DEV

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
