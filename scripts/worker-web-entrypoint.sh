#!/bin/sh
set -eu
if [ ! -e /workspace/node_modules ]; then
  ln -s /opt/cosight/node_modules /workspace/node_modules
fi
exec node assets/tour-server.js /data 8099 0.0.0.0
