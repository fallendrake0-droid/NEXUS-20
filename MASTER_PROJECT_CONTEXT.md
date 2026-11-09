# MASTER PROJECT CONTEXT — MINEFLAYER AI SWARM

You are participating in the development of one shared software project.

## My hardware

Main controller:
- Samsung Galaxy A06.
- Android 16.
- 4 GB RAM.
- Termux.
- Node.js.

The phone must be treated as a resource-constrained controller.

Remote AI:
- Ollama running on a separate device I own or control.
- Connected through a private LAN or VPN.
- No paid APIs, subscriptions or paid inference.
- No local LLM running on the Galaxy A06.

Minecraft:
- Minecraft Java Edition.
- Mineflayer.
- Private authorised testing environment for initial development.

## Core project

Build a complete intelligent, distributed Minecraft multi-bot system.

Initial deployment:
- 2 bots.

Architectural capacity:
- Up to 20 bots.
- Bots can run across multiple authorised devices.
- The phone coordinates the system.

All bots must be coordinated through one central task manager.

## The most important requirement: intelligence

The system must understand natural-language objectives and independently decide how many bots should participate.

It must never assume that all bots should work on every task.

Examples:

1. "Mine 100 cobblestone."

This means a shared total of 100 across all bots, not 100 each.

2. "Collect 100 cobblestone and 40 coal."

Create separate objectives and intelligently distribute them.

3. "Craft a wooden pickaxe."

Usually allocate one suitable bot.

4. "Explore the area."

Multiple bots may explore different directions.

5. "Build a shelter while one bot guards."

Allocate construction and guarding responsibilities separately.

Consider:
- Bot position.
- Available tools.
- Inventory.
- Health and food.
- Tool durability.
- Resource availability.
- Task difficulty.
- Expected completion time.
- Travel time.
- Task dependencies.
- Risk.
- Server connection limits.
- Coordination overhead.

Use measured evidence rather than assumptions.

## AI architecture

Use two levels of intelligence.

Level 1: Deterministic JavaScript:
- Movement.
- Navigation.
- Inventory management.
- Eating.
- Mining.
- Basic survival.
- Routine actions.
- Progress tracking.
- Reconnection.

Level 2: Remote Ollama:
- Natural-language understanding.
- Complex objective decomposition.
- Strategic decisions.
- Choosing the number of participating bots.
- Resolving ambiguous tasks.
- Replanning after failures.

Do not waste AI inference requests on every movement.

AI must propose structured decisions. Deterministic validators must check them before execution.

## Performance requirements

The phone has only 4 GB RAM.

- Do not run a local LLM.
- Avoid unnecessary dependencies.
- Avoid duplicated state.
- Limit logs and caches.
- Use event-driven updates.
- Monitor memory and CPU.
- Use adaptive workload controls.
- Avoid excessive polling.
- Keep the dashboard lightweight.
- Measure actual resource usage.
- Do not claim 20 bots can run on the phone itself.

Begin with two bots and scale gradually.

## Required interfaces

All interfaces must use the same coordinator:

1. Minecraft chat commands.
2. Web dashboard using Express and vanilla HTML/CSS/JavaScript.
3. Termux CLI.

## Required functionality

- Multiple independent Mineflayer clients.
- Shared objectives.
- Individual objectives.
- Intelligent task scheduling.
- Distributed workers.
- Worker registration.
- Heartbeats.
- Secure authentication.
- Task persistence.
- Inventory verification.
- Failure recovery.
- Reconnection.
- Remote Ollama.
- Deterministic fallback.
- Monitoring.
- Automated tests.

Use Node.js, CommonJS, async/await and modular code.

Use legitimate authentication. Offline-mode usernames are only for authorised private testing. Online-mode connections must use legitimate separately authenticated accounts. Never bypass server authentication, anti-cheat or access restrictions.

## Financial restriction

The complete project must be usable without paid API calls, paid AI subscriptions or mandatory cloud inference charges.

Distinguish free software from genuinely free model inference. Never enable automatic paid fallback.

## Engineering standards

Never invent APIs.

Check actual package compatibility.

Never claim untested functionality works.

Do not leave placeholder functions in the completed implementation.

Use shared interfaces and avoid conflicting file changes.

Prioritise:
1. Correctness.
2. Intelligent task allocation.
3. Reliability.
4. Low RAM consumption.
5. Fast execution.
6. Maintainability.

All agents must follow this shared specification.
