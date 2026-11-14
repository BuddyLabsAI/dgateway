# Changelog

## [0.1.1](https://github.com/BuddyLabsAI/dgateway/compare/v0.1.0...v0.1.1) (2026-11-14)


### Documentation

* 📝 clarify gateway positioning and setup ([c2a056c](https://github.com/BuddyLabsAI/dgateway/commit/c2a056c1ae0ac9396d60825e727856143062efaa))
* 📝 clarify gateway positioning and setup ([e9c9c2a](https://github.com/BuddyLabsAI/dgateway/commit/e9c9c2a9fd8fdb0a6a11aeab5cbc869a806b597d))

## 0.1.0 (2026-11-14)


### Features

* One API for decision models: your app sends `POST /v1/decisions` and names a route in the `model` field.
* Routes are ordered lists of steps. If a step fails, dgateway tries the next one, and request logs keep every attempt.
* Provider presets for OpenAI, OpenRouter, TypeSafe, Baseten, Liquid, Perplexity and DeepInfra, and for local Ollama and vLLM servers. A new install also has a llama.cpp provider, turned off.
* Chat models can answer decision questions too. dgateway marks those answers `"synthetic": true`.
* Each response reports the cost of the decision in US dollars and where that number came from.
* An admin console to add providers, test them and choose which ones answer each route.
* A Docker image at `ghcr.io/buddylabsai/dgateway`.
