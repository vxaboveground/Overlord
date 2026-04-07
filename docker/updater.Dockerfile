# Overlord in-app update daemon sidecar
# Watches for update-request.json written by the webapp and performs
# docker pull + compose restart on the host via the mounted Docker socket.
FROM docker:27-cli

RUN apk add --no-cache bash jq

COPY scripts/overlord-updater.sh /usr/local/bin/overlord-updater.sh
RUN chmod +x /usr/local/bin/overlord-updater.sh

CMD ["/usr/local/bin/overlord-updater.sh"]
