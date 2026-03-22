# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    ca-certificates \
    gnupg \
    wget \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# ── TT-Metal C++ toolchain ────────────────────────────────────────────────────
# Add LLVM 20 apt repo — Debian 12 bookworm doesn't ship clang-20 natively.
RUN wget -qO- https://apt.llvm.org/llvm-snapshot.gpg.key \
        | gpg --dearmor > /usr/share/keyrings/llvm-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/llvm-archive-keyring.gpg] \
http://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-20 main" \
        > /etc/apt/sources.list.d/llvm-20.list \
    && apt-get update

# clang-20, build tools, and tt-metal build deps
RUN apt-get install -y --no-install-recommends \
        clang-20 \
        clang-tidy-20 \
        clang-format-20 \
        lld-20 \
        llvm-20 \
        libc++-20-dev \
        libc++abi-20-dev \
        libstdc++-12-dev \
        cmake \
        ninja-build \
        make \
        ccache \
        python3-dev \
        python3-pip \
        python3-venv \
        pkg-config \
        libhwloc-dev \
        libnuma-dev \
        libssl-dev \
        libtbb-dev \
        libcapstone-dev \
        libatomic1 \
        xz-utils \
        xxd \
        capnproto \
        libcapnp-dev \
        libopenmpi-dev \
        openmpi-bin \
    && ln -sf /usr/bin/clang-20       /usr/local/bin/clang \
    && ln -sf /usr/bin/clang++-20     /usr/local/bin/clang++ \
    && ln -sf /usr/bin/lld-20         /usr/local/bin/lld \
    && ln -sf /usr/bin/clang-tidy-20  /usr/local/bin/clang-tidy \
    && ln -sf /usr/bin/clang-format-20 /usr/local/bin/clang-format \
    && rm -rf /var/lib/apt/lists/*

# Install SFPI cross-compiler — Tenstorrent RISC-V toolchain for Tensix cores.
# Version and SHA256 are pinned from tt_metal/sfpi-version in tenstorrent/tt-metal.
RUN SFPI_VERSION=7.30.0 \
    && SFPI_HASH=7141f448371b7f7acc9e3731c0172aca56688dcc83c8b2dfc80c835e41e6e52c \
    && wget -q -O /tmp/sfpi.deb \
        "https://github.com/tenstorrent/sfpi/releases/download/${SFPI_VERSION}/sfpi_${SFPI_VERSION}_x86_64_debian.deb" \
    && echo "${SFPI_HASH}  /tmp/sfpi.deb" | sha256sum -c - \
    && dpkg --force-depends -i /tmp/sfpi.deb \
    && rm /tmp/sfpi.deb \
    && rm -rf /var/lib/apt/lists/*
# ─────────────────────────────────────────────────────────────────────────────

# ccache — persists across container runs via /workspace/group/.ccache mount
ENV CCACHE_DIR=/workspace/group/.ccache
ENV CCACHE_MAXSIZE=10G

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
