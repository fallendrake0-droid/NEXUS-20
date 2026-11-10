# AI Protocol — Mineflayer AI Swarm

**Specification:** 1.0.0  
**Schema dialect:** JSON Schema Draft 2020-12  
**AI host:** User-controlled remote Ollama instance.  
**Trust:** Model output is untrusted input. It is never executable authority.

## 1. Responsibilities

Ollama is used only for:
- translating authorised natural-language requests into objective plans;
- decomposing complex tasks into objectives and dependency edges;
- suggesting a parallelism strategy and maximum useful participant count;
- identifying missing information and asking a clarification question;
- proposing plan changes after a material failure or changed objective.

Deterministic JavaScript owns:
- schema and semantic validation;
- registry resolution and game-version checks;
- bot eligibility and allocation;
- exact quota arithmetic;
- action preconditions and safety;
- inventory and world-state verification;
- task completion and resource ledger.

AI is not invoked for movement ticks, path updates, inventory events, eating checks or ordinary deterministic retries.

## 2. Data minimisation

### Sent to Ollama

Only a compact task context:
- request ID and current plan version;
- user's bounded natural-language objective;
- relevant objective types and known item/block names;
- compact list of candidate capability summaries (if allocation advice is requested);
- approximate positions or region labels only when travel/geometry affects strategy;
- inventory counts for required items, not slot contents;
- tool class and remaining durability band;
- health/food bands;
- measured rate summaries with sample counts and confidence;
- task dependencies, progress totals and typed failure reasons;
- configured max participant count and server connection cap.

### Never sent to Ollama

- Minecraft account credentials, Microsoft tokens, cookies or device auth files;
- worker tokens, dashboard sessions, API secrets or private keys;
- raw protocol packets, complete world/chunk dumps, full entity maps or full player lists;
- full inventory NBT/slot dumps when compact item counts suffice;
- unbounded server logs, private chat history or arbitrary files;
- phone filesystem paths, contacts or unrelated device data;
- any user data not needed for the current decision.

All model input is built from explicit allowlisted DTO fields. Never serialize a Bot object or arbitrary object graph to construct a prompt.

## 3. Ollama transport contract

Use Ollama's documented local HTTP API through the private LAN/VPN route. Preferred call: POST /api/chat with:
- configured model name;
- system and user messages containing a compact request;
- format set to the exact JSON Schema object below;
- stream false for a single bounded response;
- temperature low or zero where supported by the selected model;
- num_predict/output cap;
- keep_alive configured explicitly;
- request timeout and AbortSignal;
- bounded response body.

Ollama documents JSON Schema structured outputs through the format field and supports stream false: https://github.com/ollama/ollama/blob/main/docs/api.md

Do not assume every model perfectly obeys every schema. Parse the response content, validate locally, then run semantic validation. The coordinator must not expose Ollama directly to browser clients or workers. Protect the API endpoint with a private network boundary and authenticated TLS proxy or equivalent. No paid fallback endpoint is configured.

Recommended inference policy:
- one concurrent request by default;
- small bounded waiting queue;
- deduplicate repeated planning requests by requestId;
- cancel superseded requests;
- timeout and retry at most once for transient transport errors;
- no repeated retry on invalid schema;
- on failure use deterministic fallback for supported simple tasks;
- if complex task cannot be safely decomposed, return needs_clarification.

## 4. Plan schema

A plan contains objective decomposition, not concrete executable code and not authoritative bot assignments. Each objective has a local ID, target, dependency references, parallelism mode and a worker-count hint. The scheduler chooses actual bots.

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mineflayer-ai-swarm.local/schemas/task-plan-v1.json",
  "title": "TaskPlanV1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "requestId",
    "intentSummary",
    "clarificationRequired",
    "clarificationQuestion",
    "objectives",
    "riskLevel",
    "notes"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "requestId": { "type": "string", "format": "uuid" },
    "intentSummary": { "type": "string", "minLength": 1, "maxLength": 500 },
    "clarificationRequired": { "type": "boolean" },
    "clarificationQuestion": {
      "type": ["string", "null"],
      "maxLength": 500
    },
    "objectives": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": { "$ref": "#/$defs/objective" }
    },
    "riskLevel": { "enum": ["low", "medium", "high"] },
    "notes": {
      "type": "array",
      "maxItems": 10,
      "items": { "type": "string", "maxLength": 300 }
    }
  },
  "$defs": {
    "objective": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "localId",
        "kind",
        "target",
        "dependencies",
        "parallelism",
        "workerCountHint",
        "constraints",
        "verification"
      ],
      "properties": {
        "localId": {
          "type": "string",
          "pattern": "^[a-zA-Z0-9_-]{1,48}$"
        },
        "kind": {
          "enum": [
            "mine",
            "collect",
            "craft",
            "build",
            "explore",
            "guard",
            "transfer",
            "repair",
            "inspect"
          ]
        },
        "target": {
          "type": "object",
          "additionalProperties": false,
          "required": ["resourceId", "quantity", "regionLabel", "description"],
          "properties": {
            "resourceId": {
              "type": ["string", "null"],
              "maxLength": 128
            },
            "quantity": {
              "type": ["integer", "null"],
              "minimum": 1,
              "maximum": 1000000
            },
            "regionLabel": {
              "type": ["string", "null"],
              "maxLength": 120
            },
            "description": {
              "type": "string",
              "maxLength": 500
            }
          }
        },
        "dependencies": {
          "type": "array",
          "maxItems": 20,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9_-]{1,48}$"
          }
        },
        "parallelism": {
          "enum": [
            "single",
            "partitionable",
            "spatial",
            "role_based",
            "serial"
          ]
        },
        "workerCountHint": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        },
        "constraints": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "maxRisk",
            "avoidHazards",
            "allowExistingStock",
            "maxTravelBlocks"
          ],
          "properties": {
            "maxRisk": { "enum": ["low", "medium", "high"] },
            "avoidHazards": {
              "type": "array",
              "maxItems": 20,
              "items": { "type": "string", "maxLength": 64 }
            },
            "allowExistingStock": { "type": "boolean" },
            "maxTravelBlocks": {
              "type": ["integer", "null"],
              "minimum": 0,
              "maximum": 100000
            }
          }
        },
        "verification": {
          "enum": [
            "newly_collected",
            "held_stock",
            "deposited_stock",
            "crafted_output",
            "block_state",
            "region_visited",
            "role_duration",
            "operator_review"
          ]
        }
      }
    }
  }
}
~~~

### Plan semantic rules

- If clarificationRequired is true, clarificationQuestion must be non-empty and no executable assignments are created.
- If clarificationRequired is false, clarificationQuestion must be null.
- localId values must be unique.
- Every dependency must reference a different objective in the same plan.
- Dependency graph must be acyclic.
- Quantity must be present and positive for quantity objectives and null for non-quantity objectives unless a concrete task type defines otherwise.
- resourceId must resolve through the active minecraft-data registry; unknown IDs require clarification.
- workerCountHint is a suggestion, not a minimum and not an instruction to allocate that many workers.
- High-risk objectives require an explicit policy decision or operator confirmation.
- Model-suggested arbitrary coordinates, commands or action strings are not accepted. Target area references must be resolved by deterministic code.

## 5. Assignment schema

Actual bot assignments are authored by TaskScheduler and persisted by TaskManager, not accepted from Ollama as authoritative instructions. Worker receives this schema as a lease-bound command.

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mineflayer-ai-swarm.local/schemas/bot-assignment-v1.json",
  "title": "BotAssignmentV1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "assignmentId",
    "taskId",
    "objectiveId",
    "workerId",
    "botId",
    "allocationEpoch",
    "leaseId",
    "issuedAt",
    "expiresAt",
    "actionType",
    "quota",
    "scope",
    "verificationPolicy",
    "constraints"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "assignmentId": { "type": "string", "format": "uuid" },
    "taskId": { "type": "string", "format": "uuid" },
    "objectiveId": { "type": "string", "format": "uuid" },
    "workerId": { "type": "string", "format": "uuid" },
    "botId": { "type": "string", "format": "uuid" },
    "allocationEpoch": { "type": "integer", "minimum": 1 },
    "leaseId": { "type": "string", "format": "uuid" },
    "issuedAt": { "type": "string", "format": "date-time" },
    "expiresAt": { "type": "string", "format": "date-time" },
    "actionType": {
      "enum": [
        "mine",
        "collect",
        "craft",
        "build",
        "explore",
        "guard",
        "transfer",
        "repair",
        "inspect"
      ]
    },
    "quota": {
      "type": "object",
      "additionalProperties": false,
      "required": ["itemKey", "targetQuantity", "baselineQuantity"],
      "properties": {
        "itemKey": { "type": ["string", "null"], "maxLength": 160 },
        "targetQuantity": {
          "type": ["integer", "null"],
          "minimum": 1,
          "maximum": 1000000
        },
        "baselineQuantity": {
          "type": ["integer", "null"],
          "minimum": 0,
          "maximum": 1000000
        }
      }
    },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "required": ["regionId", "partitionId", "description"],
      "properties": {
        "regionId": { "type": ["string", "null"], "maxLength": 128 },
        "partitionId": { "type": ["string", "null"], "maxLength": 128 },
        "description": { "type": "string", "maxLength": 500 }
      }
    },
    "verificationPolicy": {
      "enum": [
        "newly_collected",
        "held_stock",
        "deposited_stock",
        "crafted_output",
        "block_state",
        "region_visited",
        "role_duration",
        "operator_review"
      ]
    },
    "constraints": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "maxRisk",
        "stopOnDeath",
        "stopOnLeaseExpiry",
        "maxActionSeconds"
      ],
      "properties": {
        "maxRisk": { "enum": ["low", "medium", "high"] },
        "stopOnDeath": { "type": "boolean" },
        "stopOnLeaseExpiry": { "const": true },
        "maxActionSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3600
        }
      }
    }
  }
}
~~~

Assignment semantic rules:
- workerId and botId must belong to one active registered worker.
- lease expiry must be later than issuedAt and no longer than configured maximum.
- targetQuantity must equal the quota committed in TaskManager.
- Sum of active quotas plus verified progress must not exceed objective target.
- Worker can execute only actionType present in its locally registered allowlist.
- Worker rejects an unknown schema version or stale allocationEpoch.
- Assignment command contains no credentials or arbitrary JavaScript.

## 6. Replanning request schema

Replanning is event-triggered, not continuous. Triggers include worker loss, unexpected resource depletion, blocked path, tool break, objective failure, changed user request or a material deviation from ETA.

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mineflayer-ai-swarm.local/schemas/replan-request-v1.json",
  "title": "ReplanRequestV1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "requestId",
    "taskId",
    "planVersion",
    "trigger",
    "affectedObjectiveIds",
    "verifiedProgress",
    "activeReservations",
    "eligibleBotSummaries",
    "failureSummary",
    "constraints"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "requestId": { "type": "string", "format": "uuid" },
    "taskId": { "type": "string", "format": "uuid" },
    "planVersion": { "type": "integer", "minimum": 1 },
    "trigger": {
      "enum": [
        "worker_lost",
        "bot_lost",
        "resource_unavailable",
        "path_blocked",
        "tool_unavailable",
        "risk_changed",
        "objective_failed",
        "user_changed_request",
        "eta_deviation"
      ]
    },
    "affectedObjectiveIds": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "uniqueItems": true,
      "items": { "type": "string", "format": "uuid" }
    },
    "verifiedProgress": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["objectiveId", "verifiedQuantity"],
        "properties": {
          "objectiveId": { "type": "string", "format": "uuid" },
          "verifiedQuantity": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1000000
          }
        }
      }
    },
    "activeReservations": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["assignmentId", "objectiveId", "quantity", "state"],
        "properties": {
          "assignmentId": { "type": "string", "format": "uuid" },
          "objectiveId": { "type": "string", "format": "uuid" },
          "quantity": { "type": "integer", "minimum": 0, "maximum": 1000000 },
          "state": { "enum": ["offered", "accepted", "running", "expired", "revoked"] }
        }
      }
    },
    "eligibleBotSummaries": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["botId", "status", "dimension", "healthBand", "foodBand", "capabilities"],
        "properties": {
          "botId": { "type": "string", "format": "uuid" },
          "status": { "enum": ["ready", "busy", "degraded", "unreachable"] },
          "dimension": { "type": "string", "maxLength": 64 },
          "healthBand": { "enum": ["critical", "low", "normal", "unknown"] },
          "foodBand": { "enum": ["critical", "low", "normal", "unknown"] },
          "capabilities": {
            "type": "array",
            "maxItems": 40,
            "items": { "type": "string", "maxLength": 80 }
          }
        }
      }
    },
    "failureSummary": { "type": "string", "maxLength": 1000 },
    "constraints": {
      "type": "object",
      "additionalProperties": false,
      "required": ["maxBots", "serverRemainingSlots", "maxRisk"],
      "properties": {
        "maxBots": { "type": "integer", "minimum": 1, "maximum": 20 },
        "serverRemainingSlots": { "type": "integer", "minimum": 0, "maximum": 20 },
        "maxRisk": { "enum": ["low", "medium", "high"] }
      }
    }
  }
}
~~~

Ollama's replan result uses the TaskPlanV1 schema with a new plan version and an explicit set of affected/new objectives. TaskManager preserves completed objectives and immutable verified credits. The model cannot erase or lower verified progress.

## 7. Task completion report schema

A completion report originates from a worker. It is not a trusted final task-completion decision.

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mineflayer-ai-swarm.local/schemas/task-completion-v1.json",
  "title": "TaskCompletionReportV1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "messageId",
    "workerId",
    "botId",
    "assignmentId",
    "allocationEpoch",
    "workerSequence",
    "reportedStatus",
    "startedAt",
    "finishedAt",
    "evidence"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "messageId": { "type": "string", "format": "uuid" },
    "workerId": { "type": "string", "format": "uuid" },
    "botId": { "type": "string", "format": "uuid" },
    "assignmentId": { "type": "string", "format": "uuid" },
    "allocationEpoch": { "type": "integer", "minimum": 1 },
    "workerSequence": { "type": "integer", "minimum": 1 },
    "reportedStatus": { "enum": ["completed", "partial", "stopped"] },
    "startedAt": { "type": "string", "format": "date-time" },
    "finishedAt": { "type": "string", "format": "date-time" },
    "evidence": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["evidenceId", "kind", "itemKey", "beforeCount", "afterCount", "observedAt"],
        "properties": {
          "evidenceId": { "type": "string", "format": "uuid" },
          "kind": {
            "enum": [
              "inventory_delta",
              "container_delta",
              "crafted_output",
              "block_state",
              "region_waypoint",
              "role_interval"
            ]
          },
          "itemKey": { "type": ["string", "null"], "maxLength": 160 },
          "beforeCount": {
            "type": ["integer", "null"],
            "minimum": 0,
            "maximum": 1000000
          },
          "afterCount": {
            "type": ["integer", "null"],
            "minimum": 0,
            "maximum": 1000000
          },
          "observedAt": { "type": "string", "format": "date-time" }
        }
      }
    }
  }
}
~~~

The transport DTO is intentionally compact. Rich evidence payloads for block coordinates, container identity or waypoint coverage use separately versioned kind-specific schemas in implementation. The worker must not smuggle unknown nested fields into this DTO.

## 8. Failure report schema

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mineflayer-ai-swarm.local/schemas/failure-report-v1.json",
  "title": "FailureReportV1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "messageId",
    "workerId",
    "botId",
    "assignmentId",
    "allocationEpoch",
    "workerSequence",
    "failureCode",
    "retryable",
    "occurredAt",
    "safeState",
    "summary"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "messageId": { "type": "string", "format": "uuid" },
    "workerId": { "type": "string", "format": "uuid" },
    "botId": { "type": "string", "format": "uuid" },
    "assignmentId": { "type": "string", "format": "uuid" },
    "allocationEpoch": { "type": "integer", "minimum": 1 },
    "workerSequence": { "type": "integer", "minimum": 1 },
    "failureCode": {
      "enum": [
        "NO_PATH",
        "PATH_TIMEOUT",
        "BOT_DISCONNECTED",
        "BOT_KICKED",
        "BOT_DIED",
        "MISSING_TOOL",
        "TOOL_BROKEN",
        "LOW_HEALTH",
        "LOW_FOOD",
        "RESOURCE_NOT_FOUND",
        "INVENTORY_FULL",
        "LEASE_EXPIRED",
        "ACTION_UNSUPPORTED",
        "SERVER_LIMIT",
        "AUTH_FAILED",
        "UNKNOWN_ACTION_ERROR"
      ]
    },
    "retryable": { "type": "boolean" },
    "occurredAt": { "type": "string", "format": "date-time" },
    "safeState": {
      "enum": ["stopped", "paused", "disconnected", "unknown"]
    },
    "summary": { "type": "string", "maxLength": 1000 }
  }
}
~~~

## 9. Assignment command envelope

Worker commands are sent over authenticated transport and include the assignment plus a delivery sequence. They are acknowledged before execution. Retries use the same commandId and leaseId; workers must deduplicate them.

~~~json
{
  "schemaVersion": 1,
  "commandId": "uuid",
  "commandSequence": 17,
  "commandType": "assignment.start",
  "issuedAt": "2026-11-09T12:00:00.000Z",
  "assignment": {}
}
~~~

## 10. Schema validation and safe fallback

- Use a maintained validator supporting JSON Schema Draft 2020-12; pin the version.
- Set additionalProperties false on every object.
- Bound strings, arrays, quantities and nesting.
- Enable format checks for UUID and date-time.
- Run semantic validation after schema validation.
- Reject duplicate local IDs, cycles, unknown registry IDs, unsupported action types, unsafe scopes and quota totals.
- Never parse model output with eval or Function.
- Never retry forever to coerce a model response.
- Keep a golden schema-valid response set for each supported model.
- Store model name, model digest/tag, prompt version, schema version, duration and validation result, but not sensitive prompt content.
- If structured output is unsupported or invalid, do not silently downgrade to unconstrained text. Use deterministic fallback or request clarification.

## 11. Prompt-injection and instruction handling

User objectives, chat strings, server text, item names and failure summaries are untrusted content. Put them in structured user data, not as instructions to replace the system policy. The system policy explicitly states the model must return only a TaskPlan, cannot select arbitrary code and cannot override limits. The validator ignores free-form notes for control decisions. No direct tool execution or command dispatch is exposed to Ollama.

## 12. Versioning and compatibility

- Schema version is an integer in every top-level message.
- Unknown major version: reject with PROTOCOL_VERSION_UNSUPPORTED.
- Adding optional fields requires a compatible schema revision and worker rollout plan.
- Removing or changing field meaning requires a new major schema version.
- Worker and master declare supported versions during registration.
- Test schema conformance against the exact pinned Ollama release and model.
- The AI feature is optional: deterministic supported tasks must work with Ollama offline.

