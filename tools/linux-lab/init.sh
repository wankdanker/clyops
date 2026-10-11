#!/bin/sh
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /dev/pts /run /tmp/uploads
mount -t devpts devpts /dev/pts 2>/dev/null || true
ip link set lo up
python3 /usr/local/lib/upload-server.py >/tmp/upload-server.log 2>&1 &
