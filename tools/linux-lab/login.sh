#!/bin/sh
cd /workspace || exit 1
export HOME=/root TERM=xterm-256color
export PATH=/workspace/examples/scripts:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
exec /bin/bash --noprofile --rcfile /root/.bashrc -i
