---
title: Configuration
description: Layered config system, global and project config examples, and API key resolution.
order: 5
---

## Layered configuration

Librarium uses a three-layer configuration system:

1. **Global config.** `~/.config/librarium/config.json`
2. **Project config.** `.librarium.json` in the current directory.
3. **CLI flags.** Passed directly to commands.

Each layer overrides the previous one:

- `defaults`: project overrides global.
- `providers`: deep-merged by provider ID; project overrides keys on conflict.
- `customProviders`: merged by provider ID; project overrides global on same ID.
- `trustedProviderIds`: union and dedupe across global and project.
- `groups`: project overrides global group names on conflict.

## Global config example

```json
{
  "version": 1,
  "defaults": {
    "outputDir": "./agents/librarium",
    "maxParallel": 6,
    "timeout": 30,
    "asyncTimeout": 1800,
    "asyncPollInterval": 10,
    "mode": "mixed"
  },
  "providers": {
    "perplexity-sonar-pro": {
      "apiKey": "$PERPLEXITY_API_KEY",
      "enabled": true
    },
    "brave-answers": {
      "apiKey": "$BRAVE_API_KEY",
      "enabled": true
    },
    "exa": {
      "apiKey": "$EXA_API_KEY",
      "enabled": true
    },
    "tavily": {
      "apiKey": "$TAVILY_API_KEY",
      "enabled": true
    }
  },
  "customProviders": {},
  "trustedProviderIds": [],
  "groups": {
    "my-custom-group": ["perplexity-sonar-pro", "exa"]
  }
}
```

## API key resolution

API keys use the `$ENV_VAR` pattern. The value `"$PERPLEXITY_API_KEY"` resolves to `process.env.PERPLEXITY_API_KEY` at runtime. Keys are never stored in plaintext.

## Model overrides

Some providers support optional model overrides. For example, to override Gemini Deep Research:

```json
{
  "providers": {
    "gemini-deep": {
      "apiKey": "$GEMINI_API_KEY",
      "enabled": true,
      "model": "gemini-2.5-flash"
    }
  }
}
```

## Project config example

Place `.librarium.json` in the root of any project to override settings for that context:

```json
{
  "defaults": {
    "outputDir": "./research",
    "timeout": 60
  },
  "providers": {
    "perplexity-sonar-pro": {
      "enabled": false
    },
    "my-script-provider": {
      "enabled": true
    }
  },
  "customProviders": {
    "my-script-provider": {
      "type": "script",
      "command": "node",
      "args": ["./scripts/librarium-provider.mjs"]
    }
  },
  "trustedProviderIds": ["my-script-provider"],
  "groups": {
    "project-research": ["my-script-provider", "exa"]
  }
}
```

## Inspect resolved config

Use `librarium config` to print the resolved configuration after merging global and project layers:

```bash
# Show resolved config
librarium config

# Show only global config
librarium config --global

# Output raw JSON
librarium config --json
```
