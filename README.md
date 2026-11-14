# dgateway

[![CI](https://github.com/BuddyLabsAI/dgateway/actions/workflows/ci.yml/badge.svg)](https://github.com/BuddyLabsAI/dgateway/actions/workflows/ci.yml) [![GHCR](https://img.shields.io/badge/GHCR-dgateway-blue)](https://github.com/BuddyLabsAI/dgateway/pkgs/container/dgateway) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Unified self-hosted API gateway for decision models.**

Decision models, such as Jev, give your code an answer it can use directly: a category, a yes or no, or a score. OpenAI offers them through its Decisions API.

With dgateway, your app calls a single API, and you choose any model behind it: OpenAI, OpenRouter, TypeSafe, another hosted vendor, or one on your own machine. You can switch models without changing your code.

## Try it

Start the container. Before you use it beyond a local trial, replace the `ADMIN_TOKEN` and `GATEWAY_SECRET` values with two different long random strings. Keep `GATEWAY_SECRET` the same over time: it encrypts the provider keys you store.

```sh
docker run -d --name dgateway \
  -p 127.0.0.1:8790:8790 \
  -v dgateway-data:/data \
  --add-host host.docker.internal:host-gateway \
  -e ADMIN_TOKEN=replace-with-a-long-random-token \
  -e GATEWAY_SECRET=replace-with-a-separate-stable-secret \
  ghcr.io/buddylabsai/dgateway:latest
```

Your app names a route in the `model` field, and the route decides which models answer. A new install has a test route named `default`. It answers with a built-in mock instead of a real model, so you need no API key. Ask it three questions about a support ticket in one request:

Example Request

```sh
curl http://127.0.0.1:8790/v1/decisions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default",
    "input": "I got charged twice for my March invoice. Please refund the extra charge.",
    "questions": [
      {
        "name": "team",
        "type": "choice",
        "instructions": "Which team should handle this ticket?",
        "choices": [
          {"value": "billing", "description": "Invoices, charges and refunds"},
          {"value": "technical", "description": "Bugs, errors and outages"},
          {"value": "account", "description": "Login, profile and access"}
        ]
      },
      {
        "name": "refund",
        "type": "predicate",
        "instructions": "Does the customer ask for a refund?"
      },
      {
        "name": "urgency",
        "type": "score",
        "instructions": "How urgent is this ticket?",
        "levels": [
          {"label": "low", "description": "Can wait a few days"},
          {"label": "normal", "description": "Answer today"},
          {"label": "high", "description": "Answer within the hour"}
        ]
      }
    ]
  }'
```

Example Response

```json
{
  "id": "dec_9d3ec5d81a46d6b61a745378",
  "object": "decision",
  "created": 1794432069,
  "model": "default",
  "answers": [
    {
      "type": "choice",
      "name": "team",
      "choice": "billing",
      "probabilities": [
        { "value": "billing", "probability": 0.4039408866995074 },
        { "value": "technical", "probability": 0.3760262725779967 },
        { "value": "account", "probability": 0.2200328407224959 }
      ],
      "confidence": 0.027914614121510695,
      "confidence_method": "upstream"
    },
    {
      "type": "predicate",
      "name": "refund",
      "probability": 0.8941176470588236
    },
    {
      "type": "score",
      "name": "urgency",
      "score": 0.870722433460076,
      "probabilities": [
        { "value": 0, "label": "low", "probability": 0.5095057034220533 },
        { "value": 1, "label": "normal", "probability": 0.11026615969581749 },
        { "value": 2, "label": "high", "probability": 0.38022813688212925 }
      ],
      "confidence": 0.129277566539924,
      "confidence_method": "upstream"
    }
  ],
  "usage": { "input_tokens": 76, "output_tokens": 3, "total_tokens": 79 },
  "gateway": {
    "route": "default",
    "provider": "mock",
    "upstream_model": "mock-1",
    "served_by": "Mock",
    "upstream_model_resolved": "mock-1",
    "synthetic": false,
    "latency_ms": 0,
    "attempts": [{ "provider": "mock", "model": "mock-1", "ok": true, "latency_ms": 0 }],
    "confidence_method": "upstream",
    "cost_usd": 0,
    "cost_basis": "upstream_cost",
    "cost_includes_output": true,
    "tokens": 76
  }
}
```

How to read it:

- `choice` is the most likely team. `probabilities` gives the probability of each team.
- The yes/no question returns `probability`, the chance that the answer is yes.
- `score` is the expected level: 0 is low and 2 is high. It is the sum of each level number times its probability.
- `gateway` names the provider and model that answered, lists each attempt and gives the cost in US dollars.

The mock does not read the text. It takes its numbers from a hash of the input, so it shows the response format, not model quality.

To connect real models, open the console at [http://127.0.0.1:8790/](http://127.0.0.1:8790/) and sign in with the admin token. There you can add providers, test them and choose which ones answer each route.

## Other ways to run it

**Docker Compose.** From a checkout of this repository, copy the example settings:

```sh
cp .env.example .env
```

Set `ADMIN_TOKEN` and `GATEWAY_SECRET` in `.env`, then start it:

```sh
docker compose up -d
```

Compose uses the published image and keeps data in the `dgateway_gateway-data` volume. `docker compose up -d --build` builds the image locally. `docker compose down -v` deletes the volume.

**From source.** Install Bun 1.3. From the repository root:

```sh
bun install
ADMIN_TOKEN=replace-with-a-long-random-token GATEWAY_SECRET=replace-with-a-separate-stable-secret bun run start
```

The API runs right away on `0.0.0.0:8790`. Set `DGATEWAY_HOST` or `DGATEWAY_PORT` to change it. Data goes to `./data`.

The Docker image includes the admin console. From source, build it once:

```sh
cd src/modules/gateway/apps/console-web
bun install
bun run build
```

Until you build it, `http://127.0.0.1:8790/` shows a placeholder page. The API works either way.

## Routes and fallback

Your app sends a route name in the `model` field, such as `"model": "support"`. A route is a list of steps in order. Each step names a provider and a model. dgateway tries the first step. If that call fails, it tries the next one.

You change the steps on the console's Models screen. Your app keeps sending the same name.

This is the `gateway` part of a real response from a test route named `support`. Its first step was OpenAI with no API key set, and its second step was the mock. The answer came from the second step:

```json
"gateway": {
  "route": "support",
  "provider": "mock",
  "upstream_model": "mock-1",
  "served_by": "Mock",
  "upstream_model_resolved": "mock-1",
  "synthetic": false,
  "latency_ms": 1,
  "attempts": [
    {
      "provider": "openai",
      "model": "gpt-6-luna",
      "ok": false,
      "latency_ms": 0,
      "error": "OPENAI_API_KEY is not set on the gateway host"
    },
    { "provider": "mock", "model": "mock-1", "ok": true, "latency_ms": 0 }
  ],
  "confidence_method": "upstream",
  "cost_usd": 0,
  "cost_basis": "upstream_cost",
  "cost_includes_output": true,
  "tokens": 76
}
```

dgateway moves to the next step after a missing key, a timeout, a network error, a malformed answer or an upstream HTTP error. An upstream HTTP 400 or 422 stops the route instead. Request logs keep every attempt, and you can filter them for requests that needed a fallback. [Routing and fallback](https://buddylabsai.github.io/dgateway/docs/guides/routing/)

## Cost per decision

Each response reports `cost_usd`, the cost in US dollars,[^1] and `cost_basis`, which says where the number came from:

| `cost_basis`       | How the cost was found                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `upstream_cost`    | The provider reported the billed amount. dgateway keeps it as reported.                                            |
| `upstream_tokens`  | Token counts from the provider, times a price per million tokens.                                                  |
| `estimated_tokens` | No token counts came back. dgateway estimates input tokens as characters ÷ 4 and applies the price.                |
| `unpriced`         | No bill and no price is known, such as a local llama.cpp or Ollama server with no price set. `cost_usd` is `null`. |

You can set a price per million input and output tokens on each route step. When no output price is known, the cost covers input only and `cost_includes_output` is `false`.

The cost belongs to the attempt that answered. dgateway assigns no cost to failed attempts, although a provider may still bill them. Treat these numbers as a view of spending, not a spending limit. [Cost guide](https://buddylabsai.github.io/dgateway/docs/guides/cost/)

[^1]: `cost_usd` is `null` when dgateway cannot price a call: the provider sent no billed amount and no price is set. A `null` means the cost is unknown, not zero.

## Providers

The console has presets for OpenAI, OpenRouter, TypeSafe (whose model is Jev), Baseten, Liquid, Perplexity and DeepInfra. Chat presets for OpenAI, OpenRouter and any OpenAI-compatible server let chat models answer decision questions too. The TypeSafe, Baseten, Liquid, Perplexity and DeepInfra presets come from each vendor's public docs. Like the chat presets, they show "Not verified yet" until a provider made from one passes a test with a live key. A new install also has a `typesafe` provider, turned off. [Providers](https://buddylabsai.github.io/dgateway/docs/guides/providers/)

## Local models

dgateway can call a model server on your own machine as well as hosted providers. The console has presets for Ollama and vLLM. A new install also has a `llamacpp` provider, turned off, that points to `http://host.docker.internal:8080` with the path `/v1/systemone`.

To keep a task on your machine, give its route only local steps. For example, turn on `llamacpp`, set its address to your server, and create this route in the console:

```text
alias: local-only
1. provider: llamacpp    model: server-configured
```

Send `"model": "local-only"`. If the local server fails, the request fails; it never goes to a hosted provider. Use a second route when you do want a hosted fallback.

Inside a container, `localhost` is the container itself. The `--add-host` line in the Docker command lets a container on Linux reach your machine as `host.docker.internal`; Docker Desktop has this name already. The model server must listen on an address the container can reach. [Providers](https://buddylabsai.github.io/dgateway/docs/guides/providers/)

## Question types

| Type        | Use it for                | You get                                             |
| ----------- | ------------------------- | --------------------------------------------------- |
| `choice`    | Sorting into 2–64 options | The top option and a probability for each one       |
| `predicate` | A yes/no check            | The probability of yes                              |
| `score`     | A rubric of 2–10 levels   | The expected level and a probability for each level |

One request can hold 1–400 questions. When a provider allows fewer, dgateway moves on to the route's next step. The [decision reference](https://buddylabsai.github.io/dgateway/docs/reference/decisions/) has every field, with tested curl and TypeScript examples.

Providers such as OpenAI, OpenRouter and TypeSafe have an API built for these questions. Chat models can answer too. dgateway asks them for token probabilities, samples several answers, or asks for a JSON estimate. It marks those answers `"synthetic": true`. [Synthetic decisions](https://buddylabsai.github.io/dgateway/docs/guides/synthetic-decisions/) explains the methods and how to test a model.

`confidence` comes from the provider when it sends one. Otherwise dgateway measures how concentrated the probabilities are. Either way, `confidence` is not proof that the answer is right. Test your provider, model, instructions and thresholds on examples you have labelled yourself before you rely on them.

## Security

- **Access:** one admin token controls the console and the admin API. Calls to `/v1/decisions` need no key until you turn on client keys in settings.
- **Provider keys:** dgateway encrypts stored keys with `GATEWAY_SECRET`. If the secret changes, it cannot read them.
- **Payloads:** logs keep no request or response bodies unless you turn on payload capture.
- **HTTPS:** dgateway does not serve HTTPS. Before you open it beyond localhost, put it behind an HTTPS proxy or limit network access.

[Security and operations](https://buddylabsai.github.io/dgateway/docs/guides/security/)

## Limits

- It has no chat-completions endpoint, so chat apps and code editors cannot use it as a model server. It can still call chat models to answer questions.
- It does not stop spending at a budget. Set limits with your providers where they offer them.
- It does not choose the best model for a task. You choose the providers and their order, and you test them.
- It is built for one operator who runs it for their own apps.

## Documentation

[Introduction](https://buddylabsai.github.io/dgateway/) · [Getting started](https://buddylabsai.github.io/dgateway/docs/guides/getting-started/) · [Decision API](https://buddylabsai.github.io/dgateway/docs/reference/decisions/) · [Routing](https://buddylabsai.github.io/dgateway/docs/guides/routing/) · [Cost](https://buddylabsai.github.io/dgateway/docs/guides/cost/) · [Providers](https://buddylabsai.github.io/dgateway/docs/guides/providers/) · [Security](https://buddylabsai.github.io/dgateway/docs/guides/security/)

## Development

The server is written in TypeScript for Bun. It runs as one process and serves the API and the console on port 8790. It keeps its settings and logs in SQLite. The console is built ahead of time and served as static files, so its packages are not needed at run time. A typed client for the API lives in `src/packages/decision-client`.

Run `bun run check` before you send a change. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, and [AGENTS.md](AGENTS.md) describes the project's module rules.

## License

[MIT](LICENSE)
