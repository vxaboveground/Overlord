#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 apply <interface> <wan|constrained|harsh>"
  echo "       $0 status <interface>"
  echo "       $0 clear <interface>"
  echo
  echo "Profiles:"
  echo "  wan          20 mbit, 40 ms ± 10 ms, 0.5% loss"
  echo "  constrained   8 mbit, 80 ms ± 25 ms, 2.0% loss"
  echo "  harsh         3 mbit, 150 ms ± 50 ms, 5.0% loss"
}

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

command_name=$1
interface_name=$2

if [[ ! $interface_name =~ ^[a-zA-Z0-9_.:-]+$ ]] || [[ ! -d "/sys/class/net/$interface_name" ]]; then
  echo "Unknown or invalid network interface: $interface_name" >&2
  exit 2
fi

if [[ $interface_name == "lo" && ${OVERLORD_NETEM_ALLOW_LOOPBACK:-0} != "1" ]]; then
  echo "Refusing to modify loopback without OVERLORD_NETEM_ALLOW_LOOPBACK=1" >&2
  exit 2
fi

if ! command -v tc >/dev/null 2>&1; then
  echo "tc was not found. Install the iproute2 package." >&2
  exit 1
fi

case $command_name in
  status)
    tc qdisc show dev "$interface_name"
    ;;
  clear)
    if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
      echo "clear requires root (run with sudo)." >&2
      exit 1
    fi
    tc qdisc del dev "$interface_name" root 2>/dev/null || true
    echo "Cleared network impairment from $interface_name"
    ;;
  apply)
    if [[ $# -ne 3 ]]; then
      usage
      exit 2
    fi
    if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
      echo "apply requires root (run with sudo)." >&2
      exit 1
    fi
    profile_name=$3
    case $profile_name in
      wan)
        rate=20mbit; delay=40ms; jitter=10ms; loss=0.5%
        ;;
      constrained)
        rate=8mbit; delay=80ms; jitter=25ms; loss=2%
        ;;
      harsh)
        rate=3mbit; delay=150ms; jitter=50ms; loss=5%
        ;;
      *)
        echo "Unknown impairment profile: $profile_name" >&2
        usage
        exit 2
        ;;
    esac
    tc qdisc replace dev "$interface_name" root netem \
      delay "$delay" "$jitter" distribution normal loss random "$loss" rate "$rate"
    echo "Applied $profile_name impairment to $interface_name"
    tc qdisc show dev "$interface_name"
    ;;
  *)
    usage
    exit 2
    ;;
esac
