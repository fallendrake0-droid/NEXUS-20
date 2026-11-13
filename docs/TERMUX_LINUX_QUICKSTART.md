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
food
hunt
mine diamond 64
collect oak_log 32
craft diamond_pickaxe 1
smelt iron_ingot 32
kit full_iron_kit
build watchtower
build animal_pen
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

## Recommended two-device setup: Termux Master + Linux Worker + remote Ollama

These are three separate roles, even if Ollama happens to run on the Linux computer:

- **Termux phone = Master:** dashboard, task queue, and the only component that calls Ollama.
- **Linux computer = Worker:** connects bots to Minecraft and polls the Master for jobs. It does not need Ollama credentials.
- **Ollama PC/device = planner:** serves a model over your private Wi-Fi or VPN. It can be the Linux Worker computer, but Ollama is still called by the Master.

### 1. Make the Termux Master reachable

In the Master setup choose **Master** (not Standalone/local bots), set its bind host to `0.0.0.0`, and keep the dashboard port (default `3000`). Start it with `npm start`. Find the phone's current LAN/VPN address, then open `http://<phone-address>:3000` from the Linux computer. Both devices need a route to each other; a private VPN also works across networks. Do not expose the plain-HTTP dashboard to the public internet.

### 2. Connect Ollama to the Master (not to each bot)

On the computer running Ollama, download the model once:

```sh
ollama pull qwen2.5:3b
ollama list
```

Ollama normally listens only on loopback. To allow the phone to reach it on a trusted private LAN, start/reconfigure Ollama to listen on the LAN interface, for example:

```sh
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Allow TCP port `11434` only from your private LAN/VPN in that computer's firewall; never port-forward it to the public internet. From Termux, check reachability (replace the address with the Ollama computer's LAN/VPN IP):

```sh
curl -fsS http://<ollama-address>:11434/api/tags
```

Then in the Control Centre open **System & AI**, choose **Ollama Self-Hosted LAN/VPN Server**, set model to `qwen2.5:3b`, set Base URL to `http://<ollama-address>:11434`, and select **Save & Activate Provider**. The URL must be the Ollama computer's reachable address, not `localhost` or `127.0.0.1` (those would point back at the phone). You can also enter the same URL and model in `npm run setup` on the Master. In the dashboard, check that the active provider says **Ready** before using the AI Control prompt. If the curl check fails, fix the network route, Ollama listen address, or firewall before changing bot settings.

The worker does not relay prompts to Ollama. Keep the Ollama URL/model only on the Master; worker setup should contain the Master URL, its enrollment token, and Minecraft settings. The command library and supported deterministic tasks remain available if Ollama is offline.

### 3. Enroll the Linux Worker

On Linux, clone/install the project and install the Mineflayer worker packages required for real bots:

```sh
git clone https://github.com/fallendrake0-droid/mineflayer-ai-swarm.git
cd mineflayer-ai-swarm
npm install
npm install --no-save mineflayer mineflayer-pathfinder
```

In the phone dashboard, open **Bots & Workers**, use **Add Worker**, enter the phone’s reachable LAN/VPN URL in **Master URL reachable from Linux**, then set a unique worker ID and the authorized Minecraft bot roster. Copy the generated Linux launch command. Do not leave `localhost` in the Master URL field for a separate Linux device. Run it in the Linux project's shell. The generated command supplies the Master URL and one-time enrollment token. Keep it private; do not post it in chat, screenshots, or public logs. The worker connects outward to the Master using HTTP polling, so you do not need to open an inbound Linux port. Once enrolled, confirm the worker and bots show online in **Bots & Workers** before dispatching a task.

If enrollment fails, check these three values first: the Master URL uses the phone's LAN/VPN address (not `127.0.0.1`), the phone dashboard port is reachable from Linux, and the bootstrap token has not already been used. Do not delete the worker state file or database as a first troubleshooting step.

## Linux update command

From the Linux project directory, update the checked-out branch with a fast-forward-only pull, then refresh dependencies if `package.json` changed:

```sh
git pull --ff-only
npm install
```

### Rename existing private offline bot usernames

Worker state and the Master normally keep enrolled usernames fixed so a restart cannot silently switch a bot to a different offline player identity. To intentionally apply a changed `SWARM_BOT_NAME_PREFIX` to an already-enrolled worker, set `SWARM_FORCE_RENAME_BOTS=true`, obtain a **fresh, unused** one-time bootstrap token from the Master, set it as `SWARM_BOOTSTRAP_TOKEN` for the worker restart, and start the worker again. The worker re-enrolls the roster so both the worker and Master use the new names. If the Master reports that a fresh bootstrap token is required, mint a new one; the token from the original enrollment is already consumed.

Changing an offline-mode username changes that player's UUID. Existing inventory and world data may remain associated with the old username, so use this only when that identity change is intended. This does not rename Microsoft-authenticated profiles; change those usernames through the legitimate Microsoft/Minecraft account settings instead. Offline-mode identities are only for private test servers you control.
