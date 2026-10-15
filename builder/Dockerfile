# Router Builder: turns ultimate/ (the router template) into a client's Windows
# installer, entirely on the Linux server. Built from the repository root:
#   docker build -f builder/Dockerfile .

# electron-builder's own image: Node, NSIS and Wine (Wine stamps the icon and version
# into the Windows executables, which electron-builder cannot do natively on Linux).
FROM electronuserland/builder:22-wine-05.26

# Go 1.20.14: the last Go that produces binaries Windows 7 can still start. Several
# client sites run Windows 7, so the engine must never be built with anything newer.
ARG GO_VERSION=1.20.14
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH \
    GOTOOLCHAIN=local \
    GOPATH=/root/go \
    ELECTRON_CACHE=/cache/electron \
    ELECTRON_BUILDER_CACHE=/cache/electron-builder \
    WINEDEBUG=-all

# The template with its dependencies, so a build never waits on npm or Go modules.
WORKDIR /template
COPY ultimate/package.json ultimate/package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY ultimate/go.mod ultimate/go.sum ./
RUN go mod download
COPY ultimate/ ./

# The worker.
WORKDIR /builder
COPY builder/package.json builder/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY builder/ ./

# Build one router now. If anything in the Linux toolchain is wrong, the image build
# fails here instead of the first real build; and Electron, NSIS and Wine's prefix end
# up cached in the image, so real builds start warm.
RUN bash /builder/warmup.sh

CMD ["node", "/builder/worker.mjs"]
