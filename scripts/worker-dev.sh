#!/usr/bin/env bash
# Run on the SSH worker. No native windows or Mac app installation.
set -euo pipefail
task_source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_name=cosight-plugin-dev
task_image=cosight-plugin-dev:20261101
task_port="${COSIGHT_DEV_PORT:-18099}"
exists() { docker container inspect "$task_name" >/dev/null 2>&1; }
owned() {
  if exists && [[ "$(docker inspect -f '{{ index .Config.Labels "ai.biosphere.task" }}' "$task_name")" != cosight-plugin-dev ]]; then
    echo "Container name belongs to another workload; leaving it unchanged." >&2
    exit 1
  fi
}
owned
case "${1:-status}" in
  build) docker build --label ai.biosphere.task=cosight-plugin-dev -f "$task_source_dir/Dockerfile.dev" -t "$task_image" "$task_source_dir" ;;
  up)
    if exists; then docker start "$task_name"; else
      docker run -d --init --name "$task_name" --label ai.biosphere.task=cosight-plugin-dev \
        --cpus=2 --memory=4g --pids-limit=512 --shm-size=512m \
        --mount "type=bind,src=$task_source_dir,dst=/workspace" \
        --mount "type=bind,src=$(dirname "$task_source_dir")/projects,dst=/projects,readonly" \
        --mount type=volume,src=cosight-plugin-dev-data,dst=/data \
        -p "127.0.0.1:$task_port:8099" -e "COSIGHT_WEB_ORIGIN=http://127.0.0.1:$task_port" "$task_image"
    fi ;;
  restart) docker restart "$task_name" ;;
  test)
    docker exec "$task_name" npm test
    docker exec "$task_name" npm run check
    docker exec "$task_name" npm run test:pure
    docker exec "$task_name" node tests/workspace-plugins-browser.cjs
    docker exec "$task_name" node tests/document-browser.cjs
    docker exec "$task_name" node tests/optional-plugins-browser.cjs ;;
  status)
    docker inspect -f '{{.State.Status}} init={{.HostConfig.Init}} image={{.Config.Image}}' "$task_name"
    curl -fsS --max-time 5 "http://127.0.0.1:$task_port/whoami"
    echo ;;
  *) echo 'Usage: worker-dev.sh build|up|restart|test|status' >&2; exit 2 ;;
esac
