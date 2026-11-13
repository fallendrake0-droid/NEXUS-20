# NEXUS-20 on Termux (Android) and Linux

NEXUS-20 can run the lightweight Master Controller and Web Control Centre on an Android phone or Linux computer. A separate WorkerHost connects to the Minecraft server and runs the bots. The Master does not load Mineflayer; keep it on the phone and run workers on a machine with a stable connection where possible.

## Requirements

- Node.js 20 or newer (Node 22/24 LTS recommended; the project uses Node's built-in SQLite module).
- Git and network access to install the project dependencies.
- For a real bot worker, a Minecraft server compatible with the configured version (defaults to 26.2), server access details, and a reachable Master URL. When a server responds with a login-throttle kick, bots now wait at least 60 seconds and stagger retries to avoid repeatedly triggering the server's rate limit.
- For Termux, install Termux from a maintained F-Droid or official GitHub release source. Android battery optimization can stop long-running background sessions; disable it for Termux if you need the Master to stay online.

## Termux (Android)

1. Install and open Termux, then update packages and install Node.js and Git:

   ```sh
   pkg update && pkg upgrade
   pkg install nodejs-lts git
   ```

   Check the runtime. `node -v` must be at least `v20`; `npm -v` should work too.

2. Clone NEXUS-20 and install dependencies:

   ```sh
   git clone https://github.com/fallendrake0-droid/mineflayer-ai-swarm.git
   cd mineflayer-ai-swarm
   npm install
   ```

3. Start the first-run setup wizard and select **Master** for a phone that will host the Control Centre:

   ```sh
   npm run setup
   ```

   Enter your Minecraft server address/version and the requested operator settings. The default Minecraft version is `26.2`. Keep the generated `.env` private; it may contain credentials or tokens.

4. Start the Master:

   ```sh
   npm start
   ```

   The terminal prints the Control Centre address, normally `http://127.0.0.1:3000` unless you chose another port. Open that URL in the phone browser. The interactive terminal also displays a `nexus>` prompt. Type a command and press **Tab** to complete it; use `Tab` repeatedly to cycle suggestions, **Shift+Tab** to cycle backward, and Enter to dispatch. Type `help` for examples and `quit` to close the prompt (the Master process then shuts down cleanly). The interactive prompt uses a clean alternate terminal screen; quitting, Ctrl+C, or closing its input restores the previous terminal display and scrollback.

   For the dashboard to be reachable from another device on your Wi-Fi, configure the Master bind host as `0.0.0.0`, allow the chosen port through the host firewall, and open `http://<phone-LAN-IP>:<port>` from the other device. Only expose the Control Centre to trusted networks; use the project's TLS/reverse-proxy options for public access.

5. On a second computer/device, start a WorkerHost using the one-time bootstrap token from the Master. Use the Control Centre's worker enrollment flow or follow the generated worker launch hint. For a WorkerHost on the same Termux installation, use a separate Termux session and the worker enrollment details; do not run Master and Worker under the same role configuration at once.

6. Optional compatibility check:

   ```sh
   npm run check:termux
   ```

   This checks Node/SQLite, durable transactions and backups, crypto, and Android/Linux system metric probes. It does not connect to a Minecraft server.

## Linux (Debian/Ubuntu example)

1. Install Node.js 20+ and Git. Use your distribution's Node.js package if it is 20 or newer, or install a current Node.js LTS release by your preferred trusted package source. Then verify:

   ```sh
   node --version
   npm --version
   git --version
   ```

2. Clone and install:

   ```sh
   git clone https://github.com/fallendrake0-droid/mineflayer-ai-swarm.git
   cd mineflayer-ai-swarm
   npm install
   ```

3. Configure and launch the Master:

   ```sh
   npm run setup
   npm start
   ```

   Select **Master** in setup. `npm start` opens the Control Centre and, in a real interactive terminal, the `nexus>` command prompt. `node index.js console` is an explicit alias for launching the Master with the interactive command prompt. Use **Tab** for Minecraft-style command completion, **Shift+Tab** to cycle backwards, arrow keys to browse, and Enter to run. `help` lists examples; `quit` cleanly stops the Master.

4. To host the Control Centre on a LAN, set the Master bind host to `0.0.0.0`, open the configured port in your firewall, and browse to `http://<linux-host-LAN-IP>:<port>`. Keep it behind an authenticated, trusted network or a correctly configured TLS reverse proxy; do not expose an unauthenticated/plain-HTTP instance to the public internet.

5. Enroll one or more WorkerHosts using the one-time token from the Control Centre. A WorkerHost can run on the same Linux machine or a separate PC. For a separate Worker, configure its Master URL to a network-reachable address (not `127.0.0.1`) and launch the Worker role using its enrollment token. Worker setup is separate from Master setup.

## Command examples

Use the Web Control Centre's always-visible command bar, or the interactive Master terminal:

```text
mine diamond 64
collect oak_log 64
craft diamond_pickaxe 1
smelt iron_ingot 32
kit full_iron_kit
build watchtower
kill Steve mace
follow Steve
mode HYBRID
stop
```

Press Tab after a partial token—for example `mi`, `mine di`, or `kill Steve ma`. Tab inserts a suggested token; repeated Tab cycles matches, and adding a space advances to suggestions for the next argument. In the web interface the visible `⇥ Tab` button provides the same completion for touch devices. Commands that are not one of the direct command actions are submitted to the deterministic Zero-AI/task intent engine. Enter commands exactly as shown, without a leading slash.

## Non-interactive / service launch

When stdin/stdout are not TTYs (for example systemd, pipes, or test runners), NEXUS-20 does not start the interactive readline prompt; the HTTP Control Centre and API continue to work. Configure the environment first, then start the Master in the foreground or under your process manager:

```sh
SWARM_ROLE=master npm start
```

For a WorkerHost, use the worker enrollment values and `npm run start:worker`. Do not paste bootstrap tokens into shared logs or public shell history.
