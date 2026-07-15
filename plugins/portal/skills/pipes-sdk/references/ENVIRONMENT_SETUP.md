# Environment Setup Guide

Verify your development environment is correctly configured for building Subsquid Pipes indexers.

## Overview

This guide helps you:
- Check all required prerequisites
- Install missing dependencies
- Verify development environment is ready
- Troubleshoot common setup issues

## Quick Checklist

Before building indexers, ensure you have:

- [ ] Node.js v22 LTS (>= 22.15.0 — required by `@subsquid/pipes`; avoid v25.x)
- [ ] npm >= 8.0.0 (or bun >= 1.0.0)
- [ ] Docker running
- [ ] ClickHouse container (for local development)
- [ ] Access to Subsquid Portal API
- [ ] TypeScript >= 5.0.0

## Prerequisites

### 1. Node.js

**Required Version**: >= 22.15.0 — `@subsquid/pipes` (1.0.0-alpha.16+) declares `engines.node >= 22.15.0`, so v20 no longer qualifies.

**WARNING: Avoid Node.js v25.x** — It has known zstd decompression bugs that cause random crashes when streaming data from the Portal API into ClickHouse.

**Check current version**:
```bash
node --version
```

**If missing or old**:

**Option A - Direct Install**:
- Download from: https://nodejs.org/
- Choose LTS (Long Term Support) version

**Option B - Using nvm (Recommended)**:
```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Install Node.js 22 LTS (recommended)
nvm install 22

# Use it
nvm use 22
nvm alias default 22

# Verify
node --version
```

**Option C - Using Homebrew (macOS)**:
```bash
brew install node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
# Add the export to your shell profile (~/.zshrc or ~/.bashrc) to make it permanent
```

**If stuck on v25.x**: The zstd bug tends to crash on large syncs (millions of blocks). For quick tests with recent blocks (~100K), v25 often works. But for production indexing, switch to LTS.

### 2. Package Manager

**Required**: npm >= 8.0.0 OR bun >= 1.0.0

**Check npm**:
```bash
npm --version
npx --version  # Should come with npm
```

**Check bun** (alternative to npm):
```bash
bun --version
```

**Install bun** (optional but faster):
```bash
curl -fsSL https://bun.sh/install | bash
```

**Note**: npm comes with Node.js installation

### 3. Docker

**Required**: Docker Desktop or Docker Engine

**Check Docker**:
```bash
# Check version
docker --version

# Check if running
docker ps
```

**If missing**:

**macOS**:
- Download Docker Desktop: https://www.docker.com/products/docker-desktop
- Install and start Docker Desktop

**Linux**:
```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Start Docker
sudo systemctl start docker
sudo systemctl enable docker

# Add user to docker group (avoid sudo)
sudo usermod -aG docker $USER
```

**Windows**:
- Download Docker Desktop: https://www.docker.com/products/docker-desktop
- Requires WSL 2

### 4. ClickHouse (Local Development)

**Required for**: Local testing and development

**Check if running**:
```bash
docker ps | grep clickhouse
```

**Start ClickHouse**:
```bash
docker run -d \
  --name clickhouse \
  -p 8123:8123 \
  -e CLICKHOUSE_PASSWORD=default \
  clickhouse/clickhouse-server
```

**Verify connection**:
```bash
docker exec clickhouse clickhouse-client \
  --password=default \
  --query "SELECT 1"
```

**Expected output**: `1`

### 5. PostgreSQL (Optional)

**Required for**: PostgreSQL-based indexers (optional)

**Check if running**:
```bash
docker ps | grep postgres
```

**Start PostgreSQL**:
```bash
docker run -d \
  --name postgres \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  postgres:16
```

### 6. TypeScript

**Required Version**: >= 5.0.0

**Check TypeScript**:
```bash
npx tsc --version
```

**If missing or old**:
```bash
# Global install (optional)
npm install -g typescript

# Or use npx (recommended)
npx tsc --version
```

### 7. Subsquid Portal API Access

**Required for**: Fetching blockchain data

**Test access**:
```bash
curl -X POST https://v2.archive.subsquid.io/query/ethereum-mainnet \
  -H "Content-Type: application/json" \
  -d '{
    "fromBlock": 18000000,
    "toBlock": 18000001,
    "logs": [],
    "fields": {
      "block": {
        "number": true
      }
    }
  }' \
  -w "\nHTTP Status: %{http_code}\n"
```

**Expected**: HTTP Status 200 with JSON response

**If fails**:
- Check internet connection
- Check firewall settings
- Try from different network

## Project-Specific Setup

If you're in an existing indexer project, verify these:

### 1. Dependencies Installed

```bash
# Check package.json exists
ls -l package.json

# Install dependencies
npm install
# or
bun install

# Verify installation
ls -l node_modules/
```

### 2. Source Files Present

```bash
# Check for main indexer file
ls -l src/main.ts src/index.ts

# Check for contract ABIs
ls -l src/contracts/
```

### 3. Environment Variables

```bash
# Check for .env file
ls -la .env

# Example .env content
cat .env
```

**Expected .env**:
```bash
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_DATABASE=pipes
CLICKHOUSE_PASSWORD=default
```

### 4. Build Test

```bash
# Try building the project
npm run build

# Or with TypeScript directly
npx tsc
```

### 5. Pipes CLI Access

```bash
# Test CLI availability
pnpx @subsquid/pipes-cli@1.0.0-alpha.4 --version
```

**Note**: No local SDK installation needed - CLI is used via pnpx

**Manual (non-CLI) setups — install the alpha tag**: a bare `npm install @subsquid/pipes` resolves to the npm `latest` tag, which is `0.1.0-beta.17` — the pre-1.0 API, a different SDK entirely. For 1.0 manual setups you must install `@subsquid/pipes@alpha` (or pin `"@subsquid/pipes": "alpha"` in `package.json`). CLI-scaffolded projects already pin `"@subsquid/pipes": "alpha"`, so only hand-written projects hit this trap.

## Platform-Specific Notes

### macOS

- **Docker Desktop** required (not Docker Engine)
- May need to allow Docker in System Preferences > Security
- Homebrew can help: `brew install node docker`

### Linux

- Docker requires sudo by default (add user to docker group)
- May need to start Docker service: `sudo systemctl start docker`
- Consider using nvm for Node.js version management

### Windows

- **WSL 2** required for Docker Desktop
- Use WSL 2 terminal for development
- Consider using nvm-windows for Node.js: https://github.com/coreybutler/nvm-windows

## IDE Recommendations

### VS Code (Recommended)

**Extensions**:
- TypeScript and JavaScript Language Features (built-in)
- ESLint
- Prettier
- Docker
- Database Client (for ClickHouse/PostgreSQL)

**Install**:
```bash
# Download from
https://code.visualstudio.com/
```

### Other IDEs

- **WebStorm** - Excellent TypeScript support
- **Cursor** - AI-powered IDE
- **Vim/Neovim** - For terminal enthusiasts

## Validation Script

Run this comprehensive check:

```bash
#!/bin/bash

echo "=== Subsquid Development Environment Check ==="
echo ""

# Node.js
echo -n "Node.js: "
node --version || echo "❌ Missing (install from nodejs.org)"

# npm/npx
echo -n "npm: "
npm --version || echo "❌ Missing"
echo -n "npx: "
npx --version || echo "❌ Missing"

# bun (optional)
echo -n "bun: "
bun --version 2>/dev/null || echo "⚠️  Optional (install from bun.sh)"

# Docker
echo -n "Docker: "
docker --version || echo "❌ Missing (install Docker Desktop)"

# Docker running
echo -n "Docker running: "
docker ps > /dev/null 2>&1 && echo "✅ Yes" || echo "❌ No (start Docker)"

# ClickHouse
echo -n "ClickHouse container: "
docker ps | grep -q clickhouse && echo "✅ Running" || echo "❌ Not running"

# PostgreSQL
echo -n "PostgreSQL container: "
docker ps | grep -q postgres && echo "⚠️  Optional" || echo "⚠️  Not running (optional)"

# TypeScript
echo -n "TypeScript: "
npx tsc --version || echo "❌ Missing"

# Portal API
echo -n "Portal API: "
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST https://v2.archive.subsquid.io/query/ethereum-mainnet \
  -H "Content-Type: application/json" \
  -d '{"fromBlock":18000000,"toBlock":18000001,"logs":[],"fields":{"block":{"number":true}}}')
[ "$STATUS" = "200" ] && echo "✅ Accessible" || echo "❌ Failed (HTTP $STATUS)"

# Pipes CLI
echo -n "Pipes CLI: "
pnpx @subsquid/pipes-cli@1.0.0-alpha.4 --version > /dev/null 2>&1 && echo "✅ Available" || echo "❌ Failed"

echo ""
echo "=== Setup Complete ==="
```

Save as `check-setup.sh`, make executable, and run:
```bash
chmod +x check-setup.sh
./check-setup.sh
```

## Common Setup Issues

### Issue 1: Docker Permission Denied

**Error**: `permission denied while trying to connect to the Docker daemon`

**Solution (Linux)**:
```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Log out and back in, or run
newgrp docker

# Verify
docker ps
```

### Issue 2: Port Already in Use

**Error**: `port 8123 is already allocated`

**Solution**:
```bash
# Check what's using the port
lsof -i :8123

# Option A: Stop existing container
docker ps
docker stop <container-id>

# Option B: Use different port
docker run -d --name clickhouse -p 8124:8123 clickhouse/clickhouse-server
# Update CLICKHOUSE_URL to http://localhost:8124
```

### Issue 3: Node.js Version Too Old

**Error**: `error:0308010C:digital envelope routines::unsupported`

**Solution**:
```bash
# Install newer Node.js with nvm
nvm install 20
nvm use 20
nvm alias default 20
```

### Issue 4: Cannot Access Portal API

**Error**: `Failed to fetch` or connection timeout

**Solution**:
```bash
# Check internet connection
ping 8.8.8.8

# Check DNS
nslookup v2.archive.subsquid.io

# Try with curl verbose
curl -v https://v2.archive.subsquid.io/query/ethereum-mainnet

# Check firewall/proxy settings
```

### Issue 5: ClickHouse Container Won't Start

**Error**: Container exits immediately

**Solution**:
```bash
# Check logs
docker logs clickhouse

# Common fix: Remove existing container
docker rm -f clickhouse

# Start fresh
docker run -d \
  --name clickhouse \
  -p 8123:8123 \
  -e CLICKHOUSE_PASSWORD=default \
  clickhouse/clickhouse-server

# Wait a few seconds
sleep 5

# Verify
docker ps | grep clickhouse
```

## Next Steps

Once environment is verified:

1. **Create first indexer**: see TEMPLATES.md and the main SKILL.md workflow
2. **Read workflow guide**: see PATTERNS.md for development workflow
3. **Test locally**: Use ClickHouse Local for development
4. **Deploy**: see DEPLOYMENT.md for production deployment

## Related Documentation

- PATTERNS.md - Indexing patterns and best practices
- DEPLOYMENT.md - Production deployment strategies
- RESEARCH_CHECKLIST.md - Protocol research workflow

## Quick Setup Summary

**Minimum setup (5 minutes)**:
```bash
# 1. Install Node.js (if needed)
# Download from nodejs.org

# 2. Install Docker (if needed)
# Download from docker.com

# 3. Start ClickHouse
docker run -d --name clickhouse -p 8123:8123 \
  -e CLICKHOUSE_PASSWORD=default clickhouse/clickhouse-server

# 4. Verify
node --version
docker ps
pnpx @subsquid/pipes-cli@1.0.0-alpha.4 --version

# 5. Ready to build!
```

That's it! You're ready to start building blockchain indexers with Subsquid Pipes.
