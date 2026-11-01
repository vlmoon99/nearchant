// GENERATED from spec/schemas by packages/contracts/scripts/gen.mjs — do not edit.
export const schemas = {
  "common.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://nearchant.com/spec/common.schema.json",
    "title": "Common",
    "description": "Shared enums for capability contracts (architecture.md §6).",
    "$defs": {
      "Capability": {
        "type": "string",
        "enum": [
          "chat",
          "vision",
          "embed",
          "rerank",
          "image.generate",
          "image.edit",
          "video.generate",
          "asr",
          "attest",
          "decide"
        ]
      },
      "PrivacyTier": {
        "description": "tee = attested confidential compute; local = the operator's own machines; public = anything else.",
        "type": "string",
        "enum": [
          "tee",
          "local",
          "public"
        ]
      },
      "DataClass": {
        "description": "private = seller or buyer data (only tee/local endpoints); public = web data, prompts with no personal data.",
        "type": "string",
        "enum": [
          "private",
          "public"
        ]
      }
    }
  },
  "providers-config.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://nearchant.com/spec/providers-config.schema.json",
    "title": "ProvidersConfig",
    "description": "config/providers.yaml: model endpoints and per-capability routing (architecture.md §10).",
    "type": "object",
    "required": [
      "endpoints",
      "routing"
    ],
    "additionalProperties": false,
    "properties": {
      "endpoints": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/Endpoint"
        },
        "minItems": 1
      },
      "routing": {
        "$ref": "#/$defs/Routing"
      },
      "models": {
        "description": "Preferred model ids per capability, tried in order against each endpoint's live catalog.",
        "type": "object",
        "additionalProperties": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "prices": {
        "description": "USD per unit by model id; missing = 0. Units: per 1M input/output tokens, per image.",
        "type": "object",
        "additionalProperties": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "inputPerMTok": {
              "type": "number",
              "minimum": 0
            },
            "outputPerMTok": {
              "type": "number",
              "minimum": 0
            },
            "perImage": {
              "type": "number",
              "minimum": 0
            },
            "perAudioMinute": {
              "type": "number",
              "minimum": 0
            }
          }
        }
      }
    },
    "$defs": {
      "Endpoint": {
        "type": "object",
        "required": [
          "id",
          "base_url",
          "privacy_tier",
          "capabilities"
        ],
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]*$"
          },
          "adapter": {
            "type": "string",
            "enum": [
              "openai-compatible",
              "replay"
            ],
            "default": "openai-compatible"
          },
          "base_url": {
            "type": "string"
          },
          "api_key_env": {
            "type": "string",
            "description": "Name of the env var holding the key; the key itself never goes in config."
          },
          "privacy_tier": {
            "$ref": "common.schema.json#/$defs/PrivacyTier"
          },
          "attestation": {
            "type": "string",
            "enum": [
              "nearai",
              "none"
            ],
            "default": "none"
          },
          "capabilities": {
            "type": "array",
            "items": {
              "$ref": "common.schema.json#/$defs/Capability"
            },
            "minItems": 1
          },
          "discover_models": {
            "type": "boolean",
            "default": true
          },
          "model_map": {
            "description": "Rename preferred model ids for this endpoint (e.g. a local served-model-name).",
            "type": "object",
            "additionalProperties": {
              "type": "string"
            }
          },
          "timeout_ms": {
            "type": "integer",
            "minimum": 100,
            "default": 120000
          },
          "extra_body": {
            "type": "object",
            "description": "Merged into every request body (e.g. chat_template_kwargs)."
          }
        }
      },
      "Routing": {
        "type": "object",
        "required": [
          "private_data_allowed_tiers"
        ],
        "properties": {
          "private_data_allowed_tiers": {
            "type": "array",
            "items": {
              "$ref": "common.schema.json#/$defs/PrivacyTier"
            }
          }
        },
        "additionalProperties": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "capability → endpoint ids in priority order"
        }
      }
    }
  },
  "result-envelope.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://nearchant.com/spec/result-envelope.schema.json",
    "title": "ResultEnvelope",
    "description": "What every capability call returns. Billing, the reviewer and the proof log read only this (architecture.md §6).",
    "type": "object",
    "required": [
      "capability",
      "output",
      "model",
      "endpointId",
      "privacyTier",
      "usage",
      "costUsd",
      "requestHash",
      "outputHash",
      "latencyMs",
      "createdAt"
    ],
    "additionalProperties": false,
    "properties": {
      "capability": {
        "$ref": "common.schema.json#/$defs/Capability"
      },
      "output": {
        "description": "Capability-specific output (chat message, vectors, image refs, transcript).",
        "tsType": "unknown"
      },
      "model": {
        "type": "string"
      },
      "endpointId": {
        "type": "string"
      },
      "privacyTier": {
        "$ref": "common.schema.json#/$defs/PrivacyTier"
      },
      "usage": {
        "$ref": "#/$defs/Usage"
      },
      "costUsd": {
        "type": "number",
        "minimum": 0,
        "description": "0 for local endpoints."
      },
      "attestation": {
        "$ref": "#/$defs/AttestationRef"
      },
      "requestHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "outputHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "latencyMs": {
        "type": "integer",
        "minimum": 0
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "replayed": {
        "type": "boolean",
        "description": "True when served by the replay provider."
      }
    },
    "$defs": {
      "Usage": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "inputTokens": {
            "type": "integer",
            "minimum": 0
          },
          "outputTokens": {
            "type": "integer",
            "minimum": 0
          },
          "images": {
            "type": "integer",
            "minimum": 0
          },
          "videoSeconds": {
            "type": "number",
            "minimum": 0
          },
          "audioSeconds": {
            "type": "number",
            "minimum": 0
          }
        }
      },
      "AttestationRef": {
        "type": "object",
        "required": [
          "kind",
          "reportHash",
          "fetchedAt"
        ],
        "additionalProperties": false,
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "nearai",
              "dstack"
            ]
          },
          "reportHash": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$",
            "description": "sha256 of the raw attestation report."
          },
          "signingAddress": {
            "type": "string"
          },
          "nonce": {
            "type": "string"
          },
          "fetchedAt": {
            "type": "string",
            "format": "date-time"
          },
          "verified": {
            "type": "boolean",
            "description": "False in M0: the report is fetched and pinned, not cryptographically verified."
          }
        }
      }
    }
  },
  "usage-record.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://nearchant.com/spec/usage-record.schema.json",
    "title": "UsageRecord",
    "description": "One metered call, signed by the gateway. Its hash is a leaf of the Merkle tree settled in the billing contract.",
    "type": "object",
    "required": [
      "recordId",
      "accountId",
      "capability",
      "endpointId",
      "model",
      "usage",
      "costUsd",
      "chargeUnits",
      "requestHash",
      "createdAt"
    ],
    "additionalProperties": false,
    "properties": {
      "recordId": {
        "type": "string"
      },
      "accountId": {
        "type": "string",
        "description": "NEAR account billed."
      },
      "capability": {
        "$ref": "common.schema.json#/$defs/Capability"
      },
      "endpointId": {
        "type": "string"
      },
      "model": {
        "type": "string"
      },
      "usage": {
        "$ref": "result-envelope.schema.json#/$defs/Usage"
      },
      "costUsd": {
        "type": "number",
        "minimum": 0
      },
      "chargeUnits": {
        "type": "string",
        "pattern": "^[0-9]+$",
        "description": "Charge in token base units (U128 string, nUSD 6 decimals)."
      },
      "requestHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "signature": {
        "type": "string",
        "description": "Gateway signature over the canonical record without this field."
      }
    }
  }
} as const;
