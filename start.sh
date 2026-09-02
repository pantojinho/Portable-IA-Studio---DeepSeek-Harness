#!/usr/bin/env bash
# Linux: ./start.sh abre o AI Studio.
cd "$(dirname "$0")"
exec ./aistudio serve "$@"
