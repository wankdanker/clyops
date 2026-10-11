FROM i386/alpine:3.21.0@sha256:7b0f18085272db228a5b32fd67f4de1e9690bfae60990971bdb0a324347e2401

# Normal Linux binaries; the guest executes the checkout's scripts unchanged.
RUN apk add --no-cache bash python3 ffmpeg curl linux-virt mkinitfs \
    && mkdir -p /workspace/inbox /run /proc /sys /dev/pts /tmp /root /usr/local/bin \
    && mkinitfs -F "base virtio 9p" "$(cat /usr/share/kernel/virt/kernel.release)" \
    && rm -rf /var/cache/apk/* /usr/share/kernel /lib/modules /etc/init.d

COPY init.sh /usr/local/bin/lab-init
COPY login.sh /usr/local/bin/lab-login
COPY bashrc /root/.bashrc
COPY upload-server.py /usr/local/lib/upload-server.py
RUN chmod +x /usr/local/bin/lab-init /usr/local/bin/lab-login \
    && printf '::sysinit:/usr/local/bin/lab-init\nttyS0::respawn:/sbin/getty -n -l /usr/local/bin/lab-login 115200 ttyS0 vt100\n::ctrlaltdel:/sbin/reboot\n' > /etc/inittab
