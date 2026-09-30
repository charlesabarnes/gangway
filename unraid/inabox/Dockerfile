# gangway in a box for Unraid: builds and watches the gangway VM (see box.sh).
# Built from the repository root: docker build -f unraid/inabox/Dockerfile .
FROM alpine:3.22
RUN apk add --no-cache busybox-extras curl jq libvirt-client qemu-img xorriso
COPY vm/cloud-init.yaml /usr/share/gangway/cloud-init.yaml
COPY web/public/apple-touch-icon.png /usr/share/gangway/gangway.png
COPY unraid/inabox/box.sh /usr/local/bin/box
RUN chmod 755 /usr/local/bin/box
EXPOSE 9124
ENTRYPOINT ["/usr/local/bin/box"]
