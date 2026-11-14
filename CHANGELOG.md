# Changelog

## 0.1.0 (2026-11-14)


### Features

* One API for decision models: your app sends `POST /v1/decisions` and names a route in the `model` field.
* Routes are ordered lists of steps. If a step fails, dgateway tries the next one, and request logs keep every attempt.
* Provider presets for OpenAI, OpenRouter, TypeSafe, Baseten, Liquid, Perplexity and DeepInfra, and for local Ollama and vLLM servers. A new install also has a llama.cpp provider, turned off.
* Chat models can answer decision questions too. dgateway marks those answers `"synthetic": true`.
* Each response reports the cost of the decision in US dollars and where that number came from.
* An admin console to add providers, test them and choose which ones answer each route.
* A Docker image at `ghcr.io/buddylabsai/dgateway`.
