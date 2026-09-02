#!/usr/bin/env bash
# Duplo clique no macOS abre o AI Studio.
cd "$(dirname "$0")"
exec ./aistudio serve "$@"
