#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_args=(
  --project-name absa-aws
  -f "$project_root/deploy/oracle/compose.yaml"
  -f "$project_root/deploy/aws/compose.override.yaml"
)

if [[ -f "$project_root/deploy/aws/.env" ]]; then
  compose_args+=(--env-file "$project_root/deploy/aws/.env")
fi

exec docker compose "${compose_args[@]}" "$@"
