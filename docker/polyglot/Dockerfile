# Sandbox for the Polyglot coding test: the toolchains of Aider's polyglot benchmark (benchmark/Dockerfile in
# Aider-AI/aider), with every dependency fetched at build time so test containers run with --network none.
# Build context: .data/datasets/polyglot (pnpm datasets:fetch polyglot builds it as ollama-bench-polyglot:<tag>).
FROM buildpack-deps:jammy

RUN apt-get update && apt-get install -y \
    software-properties-common \
    cmake \
    libboost-all-dev \
    libtbb-dev \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y \
    python3.11 \
    python3.11-venv \
    python3.11-dev \
    python3-pip \
    ca-certificates-java \
    openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && python3 -m pip install --no-cache-dir pytest==8.3.4

# Go (same version as Aider's image)
RUN ARCH=$(uname -m) && if [ "$ARCH" = "x86_64" ]; then GOARCH=amd64; elif [ "$ARCH" = "aarch64" ]; then GOARCH=arm64; else false; fi \
    && curl -fsSL "https://go.dev/dl/go1.21.5.linux-$GOARCH.tar.gz" -o /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
ENV PATH="/usr/local/go/bin:/root/.cargo/bin:${PATH}" \
    GOFLAGS=-mod=mod \
    GOTOOLCHAIN=local

# Rust
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh && sh /tmp/rustup.sh -y --profile minimal && rm /tmp/rustup.sh

# Node.js 20 + the Exercism JavaScript test stack (same packages and versions as Aider's image)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /npm-install && cd /npm-install && npm init -y >/dev/null \
    && npm install --no-audit --no-fund \
    # pinned: Aider installs jest unpinned, and Jest 30 removed toThrowError, which the Exercism tests use
    jest@29.7.0 \
    @babel/core@7.25.2 \
    @exercism/babel-preset-javascript@0.2.1 \
    @exercism/eslint-config-javascript@0.6.0 \
    @types/jest@29.5.12 \
    @types/node@20.12.12 \
    babel-jest@29.6.4 \
    core-js@3.37.1 \
    eslint@8.49.0

# Warm the offline caches from the exercises themselves: the Gradle wrapper distribution + test dependencies of
# every distinct Java build, the crates of any Rust exercise that has dependencies, and the extra crates some Rust
# reference solutions use (.meta/Cargo-example.toml; only pnpm polyglot:verify needs those).
COPY repo/java/exercises/practice /warm/java
COPY repo/rust/exercises/practice /warm/rust
RUN set -e; cd /warm/java; seen=""; for d in */; do \
      h=$(cat "$d/build.gradle" "$d/gradle/wrapper/gradle-wrapper.properties" | sha1sum | cut -c1-12); \
      case " $seen " in *" $h "*) continue;; esac; seen="$seen $h"; \
      echo "warming gradle for $d"; \
      (cd "$d" && if [ -d .meta/src/reference/java ]; then cp -r .meta/src/reference/java/. src/main/java/; fi \
        && sh ./gradlew --no-daemon -q test >/dev/null 2>&1 || true); \
    done; \
    cd /warm/rust; for d in */; do \
      if grep -q '^\[dependencies\]' "$d/Cargo.toml" && [ -n "$(sed -n '/^\[dependencies\]/,/^\[/p' "$d/Cargo.toml" | grep -v '^\[' | grep -v '^\s*$')" ]; then \
        echo "fetching crates for $d"; (cd "$d" && cargo fetch -q || true); \
      fi; \
      if [ -f "$d/.meta/Cargo-example.toml" ]; then \
        echo "fetching example crates for $d"; (cd "$d" && cp .meta/Cargo-example.toml Cargo.toml && cargo fetch -q || true); \
      fi; \
    done; \
    rm -rf /warm

WORKDIR /work
