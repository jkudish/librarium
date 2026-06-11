---
title: Getting started
description: Install librarium and run your first research query.
order: 1
---

## What is librarium?

Librarium fans out research queries to multiple search and deep-research APIs in parallel, then merges everything into one structured output. It ships with 20 built-in provider adapters spanning traditional search engines, AI-grounded answers, and deep-research APIs. Librarium works both as a CLI and as an embeddable library via `librarium/core`, which runs in Cloudflare Workers and other edge runtimes.

## Installation

### npm

Requires Node.js 20 or later.

```bash
npm install -g librarium
```

### pnpm

```bash
pnpm install -g librarium
```

### yarn

```bash
yarn global add librarium
```

### Homebrew (macOS and Linux)

```bash
brew install jkudish/tap/librarium
```

### Standalone binary

```bash
curl -fsSL https://raw.githubusercontent.com/jkudish/librarium/main/scripts/install.sh | sh
```

### npx (no install required)

```bash
npx librarium run "your query"
```

## Quick start

Run `init --auto` once to discover API keys already present in your environment and enable matching providers:

```bash
librarium init --auto
```

Then run a research query:

```bash
# Run a research query
librarium run "PostgreSQL connection pooling best practices"

# Use a specific group
librarium run "React Server Components" --group quick

# Check async deep research status
librarium status --wait
```

## Upgrade

`librarium upgrade` auto-detects your install method (npm, pnpm, yarn, Homebrew, standalone) and runs the correct upgrade command.

```bash
librarium upgrade
```
