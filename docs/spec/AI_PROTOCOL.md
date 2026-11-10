# AI Protocol, Data Minimization & Strict JSON Schemas

**Document:** `docs/spec/AI_PROTOCOL.md`  
**Specification version:** 1.1.0  
**JSON Schema Dialect:** `https://json-schema.org/draft/2020-12/schema`  
**Related:** `MASTER_SPEC.md`, `ARCHITECTURE.md`, `src/performance/AiEfficiencyController.js`

---

## 1. Non-Negotiable AI Constraints

1. **Zero local inference on phone:** `OllamaClient` rejects `127.0.0.1`, `::1`, `localhost`, `0.0.0.0`, `unix://` and RFC-3927 link-local endpoints (`DomainError('AI_LOCAL_HOST_FORBIDDEN')`).
2. **Zero paid/cloud APIs:** `OllamaClient` rejects OpenAI, Anthropic, Google Gemini, OpenRouter, Together, Groq and any host outside `config.ai.allowedHosts` (`DomainError('AI_PAID_PROVIDER_FORBIDDEN')`).
3. **Structured advisory output only:** Ollama receives compact `PlanningContextV1` (`<= 8,192 bytes` serialized UTF-8) via `POST /api/chat` with `stream: false` and `format: TASK_PLAN_V1_SCHEMA`. Model outputs are untrusted proposals validated syntactically and semantically by `SchemaValidator` before `TaskManager` accepts them.
4. **AI never runs inside real-time control loops:** Reflexes (pathfinding, eating, block digging, combat evasion, lease checks) execute 100% deterministically on `WorkerHost` with `0` LLM calls.
5. **Fast-path first (`AiEfficiencyController`):** Clear structured commands (`collect/mine/gather <N> <item>`, `craft <N> <item>`, `explore <radius>`, `guard <target>`, `status`, `pause`, `resume`, `cancel`, `stop`) bypass Ollama completely (`0` network tokens, `< 1 ms` latency).

---

## 2. Exact Data Sent to Ollama vs Kept Local on Worker

### 2.1 Permitted in `PlanningContextV1` (`<= 8,192 bytes` max)
- `schemaVersion`: `"1.0"`
- `requestId`: UUID v4
- `userIntent`: sanitized operator text (`1..500` chars; control characters stripped)
- `serverProfile`: `{ serverId, minecraftVersion, allowedActions: string[], maxBotsAvailable: integer (0..20) }`
- `botSummaries`: max `20` entries, each strictly `{ botId, dimension, status, distanceBands: Record<string, 'here'|'near'|'medium'|'far'|'unknown'>, toolTiers: string[], freeSlotBand: 'empty'|'partial'|'low'|'full', healthBand: 'critical'|'low'|'normal' }`
- `knownStockSummary`: max `25` aggregated `itemKey -> totalCount` pairs relevant to the intent
- `knownRegions`: max `16` named labels (`{ label, dimension, known: boolean }`)
- `activeConstraints`: `{ allowExistingStock: boolean, maxRiskLevel: 'low'|'medium'|'high' }`

### 2.2 Strictly Forbidden in Any Ollama Payload (Kept on Worker / Master DB)
- Raw chunk columns, voxel arrays, heightmaps, `prismarine-world` objects, pathfinder node graphs, or entity lists (`<= 549,000` voxels stay strictly inside `WorkerHost` RAM).
- Full player chat logs or untrusted in-game sign/book text (prompt-injection vector).
- Coordinates of unrelated player bases unless explicitly named in the operator's request.
- Credentials, `bootstrapToken`, `workerToken`, session IDs, Minecraft auth tokens, file paths, IPs, or environment variables.

---

## 3. Schema 1: `PlanningContextV1` (Master -> Ollama User Message JSON)

~~~json
{
  "$id": "https://mineflayer-ai-swarm.local/schemas/PlanningContextV1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "requestId",
    "userIntent",
    "serverProfile",
    "botSummaries",
    "knownStockSummary",
    "knownRegions",
    "activeConstraints"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "requestId": { "type": "string", "format": "uuid" },
    "userIntent": { "type": "string", "minLength": 1, "maxLength": 500 },
    "serverProfile": {
      "type": "object",
      "additionalProperties": false,
      "required": ["serverId", "minecraftVersion", "allowedActions", "maxBotsAvailable"],
      "properties": {
        "serverId": { "type": "string", "minLength": 1, "maxLength": 64 },
        "minecraftVersion": { "type": "string", "minLength": 3, "maxLength": 16 },
        "allowedActions": {
          "type": "array",
          "maxItems": 12,
          "uniqueItems": true,
          "items": {
            "enum": ["mine", "collect", "craft", "build", "explore", "guard", "transfer", "repair", "inspect"]
          }
        },
        "maxBotsAvailable": { "type": "integer", "minimum": 0, "maximum": 20 }
      }
    },
    "botSummaries": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["botId", "dimension", "status", "toolTiers", "freeSlotBand", "healthBand"],
        "properties": {
          "botId": { "type": "string", "minLength": 1, "maxLength": 48 },
          "dimension": { "enum": ["overworld", "the_nether", "the_end", "unknown"] },
          "status": { "enum": ["ready", "busy", "degraded"] },
          "toolTiers": { "type": "array", "maxItems": 8, "items": { "type": "string", "maxLength": 32 } },
          "freeSlotBand": { "enum": ["empty", "partial", "low", "full"] },
          "healthBand": { "enum": ["critical", "low", "normal"] }
        }
      }
    },
    "knownStockSummary": {
      "type": "object",
      "maxProperties": 25,
      "additionalProperties": { "type": "integer", "minimum": 0, "maximum": 1000000 }
    },
    "knownRegions": {
      "type": "array",
      "maxItems": 16,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["label", "dimension", "known"],
        "properties": {
          "label": { "type": "string", "minLength": 1, "maxLength": 48 },
          "dimension": { "enum": ["overworld", "the_nether", "the_end"] },
          "known": { "type": "boolean" }
        }
      }
    },
    "activeConstraints": {
      "type": "object",
      "additionalProperties": false,
      "required": ["allowExistingStock", "maxRiskLevel"],
      "properties": {
        "allowExistingStock": { "type": "boolean" },
        "maxRiskLevel": { "enum": ["low", "medium", "high"] }
      }
    }
  }
}
~~~

---

## 4. Schema 2: `TaskPlanV1` (Ollama / Fast-Path -> Master)

~~~json
{
  "$id": "https://mineflayer-ai-swarm.local/schemas/TaskPlanV1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "requestId",
    "intentSummary",
    "clarificationRequired",
    "clarificationQuestion",
    "riskLevel",
    "constraints",
    "objectives",
    "assumptions"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "requestId": { "type": "string", "format": "uuid" },
    "intentSummary": { "type": "string", "minLength": 1, "maxLength": 240 },
    "clarificationRequired": { "type": "boolean" },
    "clarificationQuestion": { "type": ["string", "null"], "maxLength": 240 },
    "riskLevel": { "enum": ["low", "medium", "high"] },
    "constraints": {
      "type": "object",
      "additionalProperties": false,
      "required": ["allowExistingStock", "maxBotsHint", "deadlineSeconds", "protectedRadiusBlocks"],
      "properties": {
        "allowExistingStock": { "type": "boolean" },
        "maxBotsHint": { "type": ["integer", "null"], "minimum": 1, "maximum": 20 },
        "deadlineSeconds": { "type": ["integer", "null"], "minimum": 10, "maximum": 86400 },
        "protectedRadiusBlocks": { "type": ["integer", "null"], "minimum": 0, "maximum": 512 }
      }
    },
    "objectives": {
      "type": "array",
      "minItems": 0,
      "maxItems": 16,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "objectiveId",
          "kind",
          "resourceId",
          "targetQuantity",
          "regionLabel",
          "description",
          "dependencies",
          "parallelism",
          "workerCountHint",
          "verificationPolicy",
          "rationale"
        ],
        "properties": {
          "objectiveId": { "type": "string", "pattern": "^obj_[a-z0-9_]{1,28}$" },
          "kind": {
            "enum": ["mine", "collect", "craft", "build", "explore", "guard", "transfer", "repair", "inspect"]
          },
          "resourceId": {
            "type": ["string", "null"],
            "pattern": "^[a-z0-9_]+:[a-z0-9_./-]+$"
          },
          "targetQuantity": { "type": ["integer", "null"], "minimum": 1, "maximum": 10000 },
          "regionLabel": { "type": ["string", "null"], "maxLength": 48 },
          "description": { "type": "string", "minLength": 1, "maxLength": 200 },
          "dependencies": {
            "type": "array",
            "maxItems": 15,
            "uniqueItems": true,
            "items": { "type": "string", "pattern": "^obj_[a-z0-9_]{1,28}$" }
          },
          "parallelism": { "enum": ["single", "partitionable", "spatial", "role_based"] },
          "workerCountHint": { "type": "integer", "minimum": 1, "maximum": 20 },
          "verificationPolicy": {
            "enum": [
              "newly_collected",
              "held_stock",
              "deposited_stock",
              "crafted_output",
              "block_state",
              "region_visited",
              "role_duration"
            ]
          },
          "rationale": { "type": "string", "minLength": 1, "maxLength": 160 }
        }
      }
    },
    "assumptions": {
      "type": "array",
      "maxItems": 8,
      "items": { "type": "string", "maxLength": 160 }
    }
  }
}
~~~

**Semantic Validation Rules (`SchemaValidator.validatePlanSemantics`):**
1. If `clarificationRequired === true`, `clarificationQuestion` must be non-null and `objectives.length === 0`.
2. If `clarificationRequired === false`, `objectives.length >= 1` and all `objectiveId` values are unique.
3. Every ID in `dependencies` must reference an `objectiveId` in the same `objectives` array, and topological sort must succeed with `0` cycles.
4. For `kind` in `{"mine", "collect", "craft", "transfer"}`, `resourceId !== null` and `targetQuantity >= 1`.

---

## 5. Schema 3: `BotAssignmentV1` (Master -> WorkerHost)

*Note: `workerCountHint` from `TaskPlanV1` is advisory only; `TaskScheduler` computes the authoritative `BotAssignmentV1` quotas.*

~~~json
{
  "$id": "https://mineflayer-ai-swarm.local/schemas/BotAssignmentV1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "assignmentId",
    "leaseId",
    "allocationEpoch",
    "taskId",
    "objectiveId",
    "workerId",
    "botId",
    "actionType",
    "resourceId",
    "quotaQuantity",
    "partitionId",
    "regionBounds",
    "verificationPolicy",
    "safetyPolicy",
    "issuedAt",
    "expiresAt",
    "checkpointIntervalMs"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "assignmentId": { "type": "string", "format": "uuid" },
    "leaseId": { "type": "string", "format": "uuid" },
    "allocationEpoch": { "type": "integer", "minimum": 1 },
    "taskId": { "type": "string", "format": "uuid" },
    "objectiveId": { "type": "string", "minLength": 1, "maxLength": 64 },
    "workerId": { "type": "string", "minLength": 1, "maxLength": 64 },
    "botId": { "type": "string", "minLength": 1, "maxLength": 48 },
    "actionType": {
      "enum": ["mine", "collect", "craft", "build", "explore", "guard", "transfer", "repair", "inspect", "safe_stop"]
    },
    "resourceId": { "type": ["string", "null"], "pattern": "^[a-z0-9_]+:[a-z0-9_./-]+$" },
    "quotaQuantity": { "type": ["integer", "null"], "minimum": 1, "maximum": 10000 },
    "partitionId": { "type": ["string", "null"], "maxLength": 48 },
    "regionBounds": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["dimension", "minX", "maxX", "minY", "maxY", "minZ", "maxZ"],
      "properties": {
        "dimension": { "enum": ["overworld", "the_nether", "the_end"] },
        "minX": { "type": "integer" },
        "maxX": { "type": "integer" },
        "minY": { "type": "integer", "minimum": -64, "maximum": 320 },
        "maxY": { "type": "integer", "minimum": -64, "maximum": 320 },
        "minZ": { "type": "integer" },
        "maxZ": { "type": "integer" }
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
        "role_duration"
      ]
    },
    "safetyPolicy": {
      "type": "object",
      "additionalProperties": false,
      "required": ["minHealth", "minFood", "avoidLava", "maxFallBlocks", "allowPvp"],
      "properties": {
        "minHealth": { "type": "number", "minimum": 4, "maximum": 20 },
        "minFood": { "type": "number", "minimum": 4, "maximum": 20 },
        "avoidLava": { "type": "boolean" },
        "maxFallBlocks": { "type": "integer", "minimum": 1, "maximum": 3 },
        "allowPvp": { "const": false }
      }
    },
    "issuedAt": { "type": "string", "format": "date-time" },
    "expiresAt": { "type": "string", "format": "date-time" },
    "checkpointIntervalMs": { "type": "integer", "minimum": 2000, "maximum": 30000 }
  }
}
~~~

---

## 6. Schema 4: `ReplanRequestV1` (Master -> ReasoningEngine / Ollama)

~~~json
{
  "$id": "https://mineflayer-ai-swarm.local/schemas/ReplanRequestV1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "requestId",
    "taskId",
    "previousPlanVersion",
    "triggerReason",
    "completedObjectiveIds",
    "verifiedProgress",
    "failedObjective",
    "botSummaries"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "requestId": { "type": "string", "format": "uuid" },
    "taskId": { "type": "string", "format": "uuid" },
    "previousPlanVersion": { "type": "integer", "minimum": 1 },
    "triggerReason": {
      "enum": [
        "RESOURCE_DEPLETED",
        "MISSING_PREREQUISITE_TOOL",
        "PATH_PERMANENTLY_BLOCKED",
        "BOT_CAPABILITY_LOST",
        "REPEATED_EXECUTION_FAILURE",
        "OPERATOR_CLARIFICATION"
      ]
    },
    "completedObjectiveIds": {
      "type": "array",
      "maxItems": 16,
      "items": { "type": "string", "maxLength": 64 }
    },
    "verifiedProgress": {
      "type": "object",
      "maxProperties": 16,
      "additionalProperties": { "type": "integer", "minimum": 0 }
    },
    "failedObjective": {
      "type": "object",
      "additionalProperties": false,
      "required": ["objectiveId", "failureCode", "summary"],
      "properties": {
        "objectiveId": { "type": "string", "maxLength": 64 },
        "failureCode": { "type": "string", "maxLength": 48 },
        "summary": { "type": "string", "maxLength": 200 }
      }
    },
    "botSummaries": {
      "$ref": "https://mineflayer-ai-swarm.local/schemas/PlanningContextV1.json#/properties/botSummaries"
    }
  }
}
~~~

---

## 7. Schema 5: `TaskCompletionReportV1` (WorkerHost -> Master)

~~~json
{
  "$id": "https://mineflayer-ai-swarm.local/schemas/TaskCompletionReportV1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "reportId",
    "assignmentId",
    "leaseId",
    "allocationEpoch",
    "taskId",
    "objectiveId",
    "workerId",
    "botId",
    "outcome",
    "durationMs",
    "beforeSnapshot",
    "afterSnapshot",
    "evidence",
    "reportedAt"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "reportId": { "type": "string", "format": "uuid" },
    "assignmentId": { "type": "string", "format": "uuid" },
    "leaseId": { "type": "string", "format": "uuid" },
    "allocationEpoch": { "type": "integer", "minimum": 1 },
    "taskId": { "type": "string", "format": "uuid" },
    "objectiveId": { "type": "string", "minLength": 1, "maxLength": 64 },
    "workerId": { "type": "string", "minLength": 1, "maxLength": 64 },
    "botId": { "type": "string", "minLength": 1, "maxLength": 48 },
    "outcome": { "enum": ["completed", "partial"] },
    "durationMs": { "type": "integer", "minimum": 0, "maximum": 86400000 },
    "beforeSnapshot": { "$ref": "#/$defs/InventorySnapshot" },
    "afterSnapshot": { "$ref": "#/$defs/InventorySnapshot" },
    "evidence": {
      "type": "array",
      "minItems": 1,
      "maxItems": 16,
      "items": { "$ref": "#/$defs/EvidenceItem" }
    },
    "reportedAt": { "type": "string", "format": "date-time" }
  },
  "$defs": {
    "InventorySnapshot": {
      "type": "object",
      "additionalProperties": false,
      "required": ["botId", "capturedAt", "itemCounts"],
      "properties": {
        "botId": { "type": "string", "minLength": 1, "maxLength": 48 },
        "capturedAt": { "type": "string", "format": "date-time" },
        "itemCounts": {
          "type": "object",
          "maxProperties": 45,
          "additionalProperties": { "type": "integer", "minimum": 0, "maximum": 100000 }
        }
      }
    },
    "EvidenceItem": {
      "type": "object",
      "additionalProperties": false,
      "required": ["evidenceId", "kind", "itemKey", "claimedDelta", "details"],
      "properties": {
        "evidenceId": { "type": "string", "format": "uuid" },
        "kind": {
          "enum": [
            "inventory_delta",
            "container_delta",
            "craft_delta",
            "transfer_delta",
            "block_state",
            "region_visited",
            "role_duration"
          ]
        },
        "itemKey": { "type": ["string", "null"], "pattern": "^[a-z0-9_]+:[a-z0-9_./-]+$" },
        "claimedDelta": { "type": "integer", "minimum": 0, "maximum": 10000 },
        "details": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "transferId": { "type": "string", "format": "uuid" },
            "counterpartyBotId": { "type": "string", "maxLength": 48 },
            "containerPos": {
              "type": "object",
              "additionalProperties": false,
              "required": ["dimension", "x", "y", "z"],
              "properties": {
                "dimension": { "enum": ["overworld", "the_nether", "the_end"] },
                "x": { "type": "integer" },
                "y": { "type": "integer" },
                "z": { "type": "integer" }
              }
            },
            "containerBeforeCount": { "type": "integer", "minimum": 0 },
            "containerAfterCount": { "type": "integer", "minimum": 0 },
            "consumedInputs": {
              "type": "object",
              "maxProperties": 9,
              "additionalProperties": { "type": "integer", "minimum": 1 }
            },
            "verifiedBlocks": { "type": "integer", "minimum": 0 },
            "coverageRatio": { "type": "number", "minimum": 0, "maximum": 1 },
            "patrolSeconds": { "type": "number", "minimum": 0 }
          }
        }
      }
    }
  }
}
~~~

---

## 8. Schema 6: `FailureReportV1` (WorkerHost -> Master)

~~~json
{
  "$id": "https://mineflayer-ai-swarm.local/schemas/FailureReportV1.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "reportId",
    "assignmentId",
    "leaseId",
    "allocationEpoch",
    "taskId",
    "objectiveId",
    "workerId",
    "botId",
    "failureCode",
    "retryable",
    "safeState",
    "summary",
    "partialReport",
    "reportedAt"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "reportId": { "type": "string", "format": "uuid" },
    "assignmentId": { "type": "string", "format": "uuid" },
    "leaseId": { "type": "string", "format": "uuid" },
    "allocationEpoch": { "type": "integer", "minimum": 1 },
    "taskId": { "type": "string", "format": "uuid" },
    "objectiveId": { "type": "string", "minLength": 1, "maxLength": 64 },
    "workerId": { "type": "string", "minLength": 1, "maxLength": 64 },
    "botId": { "type": "string", "minLength": 1, "maxLength": 48 },
    "failureCode": {
      "enum": [
        "PATH_BLOCKED",
        "RESOURCE_NOT_FOUND",
        "TOOL_BROKEN_OR_MISSING",
        "INVENTORY_FULL",
        "HEALTH_CRITICAL",
        "BOT_DIED",
        "BOT_DISCONNECTED",
        "BOT_KICKED_OR_BANNED",
        "LEASE_EXPIRED_LOCALLY",
        "OPERATOR_CANCELLED",
        "ACTION_TIMEOUT",
        "INTERNAL_EXECUTOR_ERROR"
      ]
    },
    "retryable": { "type": "boolean" },
    "safeState": { "enum": ["idle_safe", "eating_shelter", "stopped", "disconnected"] },
    "summary": { "type": "string", "minLength": 1, "maxLength": 240 },
    "partialReport": {
      "oneOf": [
        { "type": "null" },
        { "$ref": "https://mineflayer-ai-swarm.local/schemas/TaskCompletionReportV1.json" }
      ]
    },
    "reportedAt": { "type": "string", "format": "date-time" }
  }
}
~~~

---

## 9. Wire Envelope Schemas (`CommandEnvelopeV1` & `DomainEventEnvelopeV1`)

- **`CommandEnvelopeV1`** (`Master -> WorkerHost`):
  `additionalProperties: false`, required `["schemaVersion", "commandId", "sequence", "workerId", "issuedAt", "expiresAt", "commandType", "payload"]`, where `commandType` is in `["assign", "cancel", "pause", "resume", "safe_stop", "request_snapshot", "fence_epoch"]`.
- **`DomainEventEnvelopeV1`** (`WorkerHost -> Master`):
  `additionalProperties: false`, required `["schemaVersion", "messageId", "workerId", "workerSequence", "createdAt", "eventType", "payload"]`, where `eventType` is in `["assignment_progress", "assignment_completed", "assignment_failed", "bot_lifecycle", "survival_override", "chat_intent"]`.
