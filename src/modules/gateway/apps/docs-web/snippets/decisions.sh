#!/bin/sh
set -eu

base_url=${BASE_URL:-http://127.0.0.1:8790}
curl --fail-with-body --silent --show-error --max-time 10 "$base_url/v1/decisions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${CLIENT_KEY:-}" \
  -d '{
  "model": "default",
  "input": "A customer asks for an invoice refund.",
  "questions": [
    {
      "name": "team",
      "type": "choice",
      "instructions": "Choose the team.",
      "choices": [
        {
          "value": "billing",
          "description": "Invoices and refunds"
        },
        {
          "value": "technical",
          "description": "Bugs and outages"
        }
      ]
    },
    {
      "name": "urgent",
      "type": "predicate",
      "instructions": "Does this need urgent attention?"
    },
    {
      "name": "severity",
      "type": "score",
      "instructions": "Rate the severity.",
      "levels": [
        {
          "label": "low",
          "description": "Routine request"
        },
        {
          "label": "high",
          "description": "Critical incident"
        }
      ]
    }
  ]
}'
