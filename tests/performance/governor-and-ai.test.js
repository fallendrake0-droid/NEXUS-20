'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  ResourceMonitor,
  WorkloadGovernor,
  AiEfficiencyController,
  validateTaskPlanV1,
  validateOllamaEndpointPolicy,
  BoundedCache
} = require('../../src/performance');

test('ResourceMonitor measures all 11 performance domains and reports pressure transitions', async () => {
  const monitor = new ResourceMonitor({
    sampleIntervalMs: 100,
    windowSize: 10,
    thresholds: {
      warningRssBytes: 10 * 1024 * 1024 * 1024,
      criticalRssBytes: 20 * 1024 * 1024 * 1024,
      warningEventLoopLagMs: 50,
      criticalEventLoopLagMs: 150
    }
  });

  const sampleCache = new BoundedCache({ name: 'summary', maxEntries: 20 });
  sampleCache.set('b1', { ok: true });
  monitor.registerCache('summary', sampleCache);
  monitor.registerQueueProbe('tasks', () => 3);
  monitor.recordNetworkBytes({ rxBytes: 2048, txBytes: 1024, requestStarted: true, requestEnded: true });
  monitor.recordDbLatency(1.4);
  monitor.recordAiEvent('deterministicFastPath');
  monitor.recordDashboardUpdate({ clients: 2, rawEvents: 8, coalescedFlushes: 1, serializedBytes: 512 });

  monitor.start();
  await new Promise((r) => setTimeout(r, 40));
  const s1 = monitor.sampleNow();
  assert.ok(s1.memory.rssBytes > 0);
  assert.ok(s1.memory.heapUsedBytes > 0);
  assert.notEqual(s1.memory.systemAvailableBytes, 0);
  assert.equal(s1.queues.tasks, 3);
  assert.equal(s1.caches.totalEntries, 1);
  assert.equal(s1.ai.deterministicFastPathTotal, 1);
  assert.equal(s1.dashboard.activeClients, 2);
  assert.equal(s1.pressure, 'normal');

  monitor.recordEventLoopLag(180);
  const sCrit = monitor.sampleNow();
  assert.equal(sCrit.pressure, 'critical');
  assert.equal(monitor.pressureState(), 'critical');

  const win = monitor.getWindow();
  assert.equal(win.sampleCount, 2);
  assert.ok(win.aggregates.rssBytes.p95 > 0);
  monitor.stop();
});

test('WorkloadGovernor scales down under pressure, preserves survival/safety, never drops tasks and recovers stepwise', () => {
  assert.throws(() => new WorkloadGovernor({ globalBotCap: 21 }), RangeError);

  let now = 1000;
  const gov = new WorkloadGovernor({
    globalBotCap: 20,
    initialBotCap: 6,
    recoveryCooldownMs: 5000,
    thresholds: {
      constrainedRssBytes: 200_000_000,
      criticalRssBytes: 300_000_000,
      recoverFromCriticalRssBytes: 250_000_000,
      recoverFromConstrainedRssBytes: 180_000_000
    },
    now: () => now
  });

  const events = [];
  gov.on('workload.reduction', (ev) => events.push(ev));

  assert.equal(gov.state, 'normal');
  assert.equal(gov.getDirectives().effectiveBotConcurrency, 6);

  // Escalate to constrained
  const t1 = gov.evaluate({
    memory: { rssBytes: 230_000_000 },
    cpu: { percentNormalized: 40 },
    eventLoopDelayMs: { p95: 12 },
    queues: { tasks: 4 }
  });
  assert.equal(t1.changed, true);
  assert.equal(gov.state, 'constrained');
  const dConstrained = gov.getDirectives({ serverAvailableSlots: 10, workerAvailableSlots: 10, capabilityEligibleBots: 10 });
  assert.equal(dConstrained.effectiveBotConcurrency, 3);
  assert.equal(dConstrained.dashboardFlushIntervalMs, 3000);
  assert.equal(dConstrained.allowNonEssentialAi, false);
  assert.equal(dConstrained.preserveSurvivalAndSafety, true);

  // Low-priority task is paused and queued — NEVER dropped!
  const lowDecision = gov.classifyWork({ taskId: 'task-low-1', priority: 'low', payload: { text: 'explore' } });
  assert.equal(lowDecision.decision, 'paused_and_queued');
  assert.equal(gov.pausedTaskCount, 1);

  // Escalate to critical
  now += 1000;
  gov.evaluate({
    memory: { rssBytes: 320_000_000 },
    cpu: { percentNormalized: 95 },
    eventLoopDelayMs: { p95: 200 },
    queues: { tasks: 10 }
  });
  assert.equal(gov.state, 'critical');
  assert.equal(gov.getDirectives().effectiveBotConcurrency, 0);
  assert.equal(gov.getDirectives().allowNonEssentialScanning, false);

  // Survival & safety operations STILL execute immediately in critical state!
  const survivalDecision = gov.classifyWork({ taskId: 'eat-now', priority: 'survival' });
  assert.equal(survivalDecision.decision, 'execute_now');
  assert.equal(survivalDecision.preservedSafety, true);

  // Normal task in critical state is also safely paused & retained
  const normDecision = gov.classifyWork({ taskId: 'task-norm-2', priority: 'normal' });
  assert.equal(normDecision.decision, 'paused_and_queued');
  assert.equal(gov.pausedTaskCount, 2);

  // Stepwise recovery: critical -> constrained after 5000ms below critical recovery band
  now += 1000;
  gov.evaluate({
    memory: { rssBytes: 150_000_000 },
    cpu: { percentNormalized: 20 },
    eventLoopDelayMs: { p95: 5 },
    queues: { tasks: 2 }
  });
  assert.equal(gov.state, 'critical'); // Cooldown just started

  now += 5500;
  gov.evaluate({
    memory: { rssBytes: 150_000_000 },
    cpu: { percentNormalized: 20 },
    eventLoopDelayMs: { p95: 5 },
    queues: { tasks: 2 }
  });
  assert.equal(gov.state, 'constrained'); // Stepped down ONE level first!

  // Constrained -> normal after second cooldown window
  now += 100;
  gov.evaluate({
    memory: { rssBytes: 150_000_000 },
    cpu: { percentNormalized: 20 },
    eventLoopDelayMs: { p95: 5 },
    queues: { tasks: 2 }
  });
  now += 5500;
  gov.evaluate({
    memory: { rssBytes: 150_000_000 },
    cpu: { percentNormalized: 20 },
    eventLoopDelayMs: { p95: 5 },
    queues: { tasks: 2 }
  });
  assert.equal(gov.state, 'normal');

  // All 2 deferred tasks are recovered intact — zero dropped tasks!
  const resumed = gov.drainResumableTasks(10);
  assert.equal(resumed.length, 2);
  assert.deepEqual(
    resumed.map((r) => r.taskId),
    ['task-low-1', 'task-norm-2']
  );
  assert.ok(events.length >= 3);
});

test('AiEfficiencyController blocks local phone Ollama and paid cloud endpoints', () => {
  assert.throws(
    () => validateOllamaEndpointPolicy('http://127.0.0.1:11434', { enforceRemoteOnController: true }),
    (err) => err.code === 'AI_LOCAL_HOST_FORBIDDEN'
  );
  assert.throws(
    () => validateOllamaEndpointPolicy('http://localhost:11434', { enforceRemoteOnController: true }),
    (err) => err.code === 'AI_LOCAL_HOST_FORBIDDEN'
  );
  assert.throws(
    () => validateOllamaEndpointPolicy('https://api.openai.com/v1', { enforceRemoteOnController: true }),
    (err) => err.code === 'AI_PAID_PROVIDER_FORBIDDEN'
  );
  assert.throws(
    () => validateOllamaEndpointPolicy('https://api.anthropic.com', { enforceRemoteOnController: false }),
    (err) => err.code === 'AI_PAID_PROVIDER_FORBIDDEN'
  );
  assert.throws(
    () => validateOllamaEndpointPolicy('http://user:secret@192.168.1.10:11434'),
    (err) => err.code === 'AI_INVALID_ENDPOINT'
  );

  // Private LAN/VPN Ollama host is permitted
  const ok = validateOllamaEndpointPolicy('https://10.8.0.12:11434', { enforceRemoteOnController: true });
  assert.equal(ok.hostname, '10.8.0.12');

  const ai = new AiEfficiencyController();
  assert.deepEqual(ai.listProviders().map((provider) => provider.name).sort(), ['none', 'ollama']);
  assert.throws(
    () => ai.configureProvider({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }),
    (err) => err.code === 'AI_LOCAL_HOST_FORBIDDEN'
  );
  assert.throws(() => ai.configureProvider({ provider: 'openai', apiKey: 'sk-must-not-load' }), (err) => {
    assert.equal(err.code, 'AI_PAID_PROVIDER_FORBIDDEN');
    return true;
  });
  assert.throws(() => ai.setProvider('gemini'), (err) => err.code === 'AI_PAID_PROVIDER_FORBIDDEN');
});

test('AiEfficiencyController handles canonical intents with 0 LLM calls, deduplicates, caches, validates and falls back', async () => {
  let remoteCallCount = 0;
  let lastPlanningDto = null;
  const ai = new AiEfficiencyController({
    ollamaBaseUrl: 'https://10.8.0.12:11434',
    maxConcurrent: 1,
    maxQueue: 2,
    timeoutMs: 80,
    transportOverride: async ({ body }) => {
      remoteCallCount += 1;
      const userDto = JSON.parse(body.messages[1].content);
      lastPlanningDto = userDto;
      if (userDto.userObjective.includes('slow_timeout')) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (userDto.userObjective.includes('cyclic_bad_plan')) {
        return {
          schemaVersion: 1,
          requestId: userDto.requestId,
          intentSummary: 'Bad cyclic plan',
          clarificationRequired: false,
          clarificationQuestion: null,
          objectives: [
            {
              localId: 'a',
              kind: 'mine',
              target: { resourceId: 'minecraft:stone', quantity: 10, regionLabel: null, description: 'a' },
              dependencies: ['b'],
              parallelism: 'single',
              workerCountHint: 1,
              constraints: { maxRisk: 'low', avoidHazards: [], allowExistingStock: false, maxTravelBlocks: 100 },
              verification: 'newly_collected'
            },
            {
              localId: 'b',
              kind: 'mine',
              target: { resourceId: 'minecraft:stone', quantity: 10, regionLabel: null, description: 'b' },
              dependencies: ['a'],
              parallelism: 'single',
              workerCountHint: 1,
              constraints: { maxRisk: 'low', avoidHazards: [], allowExistingStock: false, maxTravelBlocks: 100 },
              verification: 'newly_collected'
            }
          ],
          riskLevel: 'low',
          notes: []
        };
      }
      await new Promise((r) => setTimeout(r, 20));
      return {
        schemaVersion: 1,
        requestId: userDto.requestId,
        intentSummary: 'Multi-step iron smelt preparation',
        clarificationRequired: false,
        clarificationQuestion: null,
        objectives: [
          {
            localId: 'mine_raw_iron',
            kind: 'mine',
            target: {
              resourceId: 'minecraft:raw_iron',
              quantity: 24,
              regionLabel: 'cave_sector_a',
              description: 'Mine 24 raw iron aggregate'
            },
            dependencies: [],
            parallelism: 'partitionable',
            workerCountHint: 2,
            constraints: {
              maxRisk: 'medium',
              avoidHazards: ['lava'],
              allowExistingStock: false,
              maxTravelBlocks: 512
            },
            verification: 'newly_collected'
          }
        ],
        riskLevel: 'medium',
        notes: []
      };
    }
  });

  // 1. All 5 MASTER_PROJECT_CONTEXT.md canonical examples resolve deterministically with ZERO LLM calls!
  const c1 = await ai.createPlan({ userText: 'Mine 100 cobblestone.' });
  assert.equal(c1.llmCalled, false);
  assert.equal(c1.plan.objectives.length, 1);
  assert.equal(c1.plan.objectives[0].target.quantity, 100);

  const c2 = await ai.createPlan({ userText: 'Collect 100 cobblestone and 40 coal.' });
  assert.equal(c2.llmCalled, false);
  assert.equal(c2.plan.objectives.length, 2);
  assert.equal(c2.plan.objectives[0].target.quantity, 100);
  assert.equal(c2.plan.objectives[1].target.quantity, 40);

  const c3 = await ai.createPlan({ userText: 'Craft a wooden pickaxe.' });
  assert.equal(c3.llmCalled, false);
  assert.equal(c3.plan.objectives[0].parallelism, 'single');
  assert.equal(c3.plan.objectives[0].workerCountHint, 1);

  const c4 = await ai.createPlan({ userText: 'Explore the area.' });
  assert.equal(c4.llmCalled, false);
  assert.equal(c4.plan.objectives[0].parallelism, 'spatial');

  const c5 = await ai.createPlan({ userText: 'Build a shelter while one bot guards.' });
  assert.equal(c5.llmCalled, false);
  assert.equal(c5.plan.objectives.length, 2);
  assert.equal(remoteCallCount, 0);

  // 2. 8 concurrent identical complex intents deduplicate onto ONE single remote Ollama call!
  const complexPrompt = 'Prepare an iron expedition if caves look promising near spawn';
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      ai.createPlan({ requestId: crypto.randomUUID(), userText: complexPrompt })
    )
  );
  assert.equal(remoteCallCount, 1);
  assert.equal(new Set(results.map((r) => r.plan.requestId)).size, 8);

  // 3. Subsequent call hits BoundedCache with 0 remote calls
  const cached = await ai.createPlan({ userText: complexPrompt });
  assert.equal(cached.source, 'cache');
  assert.equal(cached.llmCalled, false);
  assert.equal(remoteCallCount, 1);

  // Explicit AI requests bypass deterministic plans and cached templates.
  const forced = await ai.createPlan({
    userText: complexPrompt,
    forceAI: true,
    compactContext: { conversationContext: 'Earlier the user asked for a cautious iron expedition.' }
  });
  assert.equal(forced.llmCalled, true);
  assert.equal(forced.source, 'remote_ollama');
  assert.equal(lastPlanningDto.userObjective, complexPrompt);
  assert.equal(lastPlanningDto.conversationContext, 'Earlier the user asked for a cautious iron expedition.');
  assert.equal(remoteCallCount, 2);

  // 4. Cyclic schema-invalid response is rejected with NO retry loop and safe clarification fallback
  const bad = await ai.createPlan({ userText: 'Please run cyclic_bad_plan strategy' });
  assert.equal(bad.source, 'schema_rejected_fallback');
  assert.equal(bad.plan.clarificationRequired, true);
  assert.equal(remoteCallCount, 3); // Only 1 call made, NOT retried!

  // 5. Timeout triggers deterministic clarification fallback cleanly
  const timedOut = await ai.createPlan({ userText: 'Please run slow_timeout strategy' });
  assert.equal(timedOut.source, 'error_fallback');
  assert.equal(timedOut.errorCode, 'AI_TIMEOUT');
  assert.equal(timedOut.plan.clarificationRequired, true);
  assert.equal(validateTaskPlanV1(timedOut.plan).valid, true);
});
