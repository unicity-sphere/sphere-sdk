# tests/e2e/local-infra/aggregator-image/proxy/Dockerfile
#
# Tiny ssl-manager-wrapped reverse proxy. Sits in front of the
# aggregator + bft + mongo stack and is the only container exposed
# to HAProxy. Terminates TLS on :443 with a Let's Encrypt cert
# acquired via certbot (built into ssl-manager) and proxies plain
# HTTP/JSON-RPC traffic to the aggregator container on its internal
# port (3000 by default).
#
# Build (from tests/e2e/local-infra/aggregator-image/):
#   docker build -f proxy/Dockerfile -t unicity-aggregator-proxy:latest proxy/

FROM ghcr.io/unicitynetwork/ssl-manager:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
        tini nginx ca-certificates curl gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY nginx.conf.template /etc/nginx/templates/aggregator.conf.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

VOLUME ["/etc/letsencrypt"]

EXPOSE 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsSk https://127.0.0.1:443/health >/dev/null || curl -fsS http://127.0.0.1:80/.well-known/acme-challenge/ -o /dev/null || exit 1

ENV AGGREGATOR_BACKEND_HOST=aggregator \
    AGGREGATOR_BACKEND_PORT=3000

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
