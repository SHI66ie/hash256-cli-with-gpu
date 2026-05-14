const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Simple .env loader
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.length > 0 && value.startsWith('"') && value.endsWith('"')) {
          value = value.replace(/^"|"$/g, '');
        }
        process.env[key] = value;
      }
    });
    console.log('[Dashboard] Loaded .env file');
  }
} catch (e) {
  console.error('[Dashboard] Error loading .env:', e.message);
}

let currentStats = {
  hashRate: 0,
  roundTime: 0,
  attempts: 0,
  epoch: 0,
  block: 0,
  difficulty: 0,
  challenge: '',
  status: 'Initializing...',
  startTime: Date.now(),
  lastUpdate: Date.now(),
  gpuDevice: 'Detecting...',
  gpuBatch: 0,
  era: 0,
  reward: 0,
  minted: 0,
  totalToMint: 0,
  blocksLeft: 0,
  successCount: 0,
  lastSuccess: null,
  minerAddress: '0x...'
};

function parseLine(rawLine) {
  // Handle multiple updates on one line (common with \r)
  const lines = rawLine.split('\r');
  const line = lines[lines.length - 1]; // Only parse the latest update

  const hashRateMatch = line.match(/⚡\s*([\d.,]+)\s*H\/s/);
  const roundTimeMatch = line.match(/round\s*([\d.]+)s/);
  const attemptsMatch = line.match(/attempts\s*([\d,]+)/);

  if (hashRateMatch) {
    currentStats.hashRate = parseFloat(hashRateMatch[1].replace(/,/g, ''));
    currentStats.roundTime = roundTimeMatch ? parseFloat(roundTimeMatch[1]) : 0;
    currentStats.attempts = attemptsMatch ? parseInt(attemptsMatch[1].replace(/,/g, '')) : 0;
    currentStats.status = 'Mining';
    currentStats.lastUpdate = Date.now();
  }

  // GPU Info (handling potential emojis)
  const gpuMatch = line.match(/GPU device:\s+(.+)/);
  if (gpuMatch) currentStats.gpuDevice = gpuMatch[1].trim();
  const batchMatch = line.match(/GPU batch size:\s+(\d+)/);
  if (batchMatch) currentStats.gpuBatch = parseInt(batchMatch[1]);

  // Miner Address
  const addressMatch = line.match(/(?:Miner address|Address):\s+(0x[a-f0-9]+)/i);
  if (addressMatch) currentStats.minerAddress = addressMatch[1];

  // Mining State Info
  const eraMatch = line.match(/Era:\s+(\d+)/);
  if (eraMatch) currentStats.era = parseInt(eraMatch[1]);
  
  const rewardMatch = line.match(/Reward:\s+([\d.]+)/);
  if (rewardMatch) currentStats.reward = parseFloat(rewardMatch[1]) / 1e18;

  const mintedMatch = line.match(/Mining minted:\s+(\d+)\s*\/\s*(\d+)/);
  if (mintedMatch) {
    currentStats.minted = parseInt(mintedMatch[1]);
    currentStats.totalToMint = parseInt(mintedMatch[2]);
  }

  const blocksLeftMatch = line.match(/Blocks left in epoch:\s+(\d+)/);
  if (blocksLeftMatch) currentStats.blocksLeft = parseInt(blocksLeftMatch[1]);

  // Block/epoch line: "   Block: 25072254  Epoch: 250722"
  const blockMatch = line.match(/Block:\s+(\d+)/);
  const epochMatch = line.match(/Epoch:\s+(\d+)/);
  if (blockMatch) currentStats.block = parseInt(blockMatch[1]);
  if (epochMatch) currentStats.epoch = parseInt(epochMatch[1]);

  // Difficulty: "   Difficulty: 411376..."
  const diffMatch = line.match(/Difficulty:\s+(\d+)/);
  if (diffMatch) currentStats.difficulty = diffMatch[1];

  // Challenge: "   Challenge: 0x42ae..."
  const challengeMatch = line.match(/Challenge:\s+(0x[a-f0-9]+)/i);
  if (challengeMatch) currentStats.challenge = challengeMatch[1];

  // Success: "🎉 FOUND VALID NONCE" or "🎉 FOUND NONCE"
  if (line.includes('FOUND VALID NONCE') || line.includes('FOUND NONCE')) {
    currentStats.status = 'Found nonce! Submitting...';
  }
  if (line.includes('SUCCESS')) {
    currentStats.status = 'Minted successfully!';
    currentStats.lastSuccess = Date.now();
    currentStats.successCount++;
  }
  if (line.includes('Transaction reverted') || line.includes('REVERTED')) {
    currentStats.status = 'Transaction reverted';
  }

  // Epoch changed
  if (line.includes('Epoch changed') || line.includes('New Epoch detected')) {
    currentStats.status = 'Epoch changed, restarting...';
  }

  // RPC errors
  if (line.includes('RPC error') || line.includes('block poll failed') || line.includes('FAILED')) {
    currentStats.status = 'Error - check logs';
  }
}

let minerOutputBuffer = '';

function startMiner() {
  const minerPath = path.join(__dirname, 'target', 'release', 'hash-miner-rs.exe');

  console.log('[Dashboard] Starting miner...');
  const miner = spawn(minerPath, [], {
    env: {
      ...process.env,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
      RPC_URL: process.env.RPC_URL,
      MINER_THREADS: process.env.MINER_THREADS || '8',
      GPU: process.env.GPU || '0',
      GPU_BATCH: process.env.GPU_BATCH || '4194304',
      PRIORITY_GWEI: process.env.PRIORITY_GWEI || '5'
    },
    cwd: __dirname
  });

  const handleData = (data) => {
    minerOutputBuffer += data.toString();
    
    // We want to parse the most complete chunks.
    // Lines are often updated with \r, so we split by both \n and \r
    let parts = minerOutputBuffer.split(/[\n\r]+/);
    
    // Keep the last potentially incomplete part in the buffer
    if (minerOutputBuffer.endsWith('\n') || minerOutputBuffer.endsWith('\r')) {
        minerOutputBuffer = '';
    } else {
        minerOutputBuffer = parts.pop();
    }

    parts.forEach(line => {
      if (line.trim()) {
        parseLine(line);
        // Log all lines if not mining yet, otherwise only important ones
        const lowerLine = line.toLowerCase();
        if (currentStats.status !== 'Mining' || lowerLine.includes('⚡') || lowerLine.includes('success') || lowerLine.includes('found') || lowerLine.includes('address')) {
           console.log('[Miner]', line.trim().replace(/\r/g, ''));
        }
      }
    });
  };

  miner.stdout.on('data', handleData);
  miner.stderr.on('data', handleData);

  miner.on('close', (code) => {
    console.log(`[Dashboard] Miner exited with code ${code}`);
    currentStats.status = 'Miner stopped';
  });

  return miner;
}

// HTML Dashboard
const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HASH Miner Dashboard</title>
    <style>
        :root {
            --bg: #050508;
            --card-bg: rgba(18, 18, 26, 0.7);
            --accent: #00ff88;
            --accent-glow: rgba(0, 255, 136, 0.3);
            --secondary: #00ccff;
            --text: #e0e0e0;
            --text-dim: #888;
            --border: rgba(255, 255, 255, 0.05);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'Outfit', 'Segoe UI', system-ui, sans-serif;
            background: var(--bg);
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(0, 255, 136, 0.05) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(0, 204, 255, 0.05) 0%, transparent 40%);
            color: var(--text);
            min-height: 100vh;
            padding: 40px 20px;
            overflow-x: hidden;
        }

        .container { max-width: 1000px; margin: 0 auto; position: relative; }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-bottom: 40px;
            border-bottom: 1px solid var(--border);
            padding-bottom: 20px;
        }

        h1 {
            font-size: 2.5rem;
            font-weight: 800;
            background: linear-gradient(135deg, #fff 0%, #888 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -1px;
        }

        .subtitle { 
            color: var(--text-dim); 
            font-size: 0.9rem;
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 5px;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }

        .card {
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            position: relative;
            overflow: hidden;
        }

        .card::before {
            content: '';
            position: absolute;
            top: 0; left: 0; width: 100%; height: 100%;
            background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, transparent 100%);
            pointer-events: none;
        }

        .card:hover { 
            transform: translateY(-5px);
            border-color: rgba(0, 255, 136, 0.4);
            box-shadow: 0 10px 30px -10px var(--accent-glow);
        }

        .card-label {
            color: var(--text-dim);
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            margin-bottom: 12px;
            font-weight: 600;
        }

        .card-value {
            font-size: 1.8rem;
            font-weight: 700;
            color: #fff;
            font-variant-numeric: tabular-nums;
        }

        .hash-rate { color: var(--accent); text-shadow: 0 0 20px var(--accent-glow); }
        .attempts { color: var(--secondary); }
        .epoch { color: #ffaa00; }
        .status { color: #ff55aa; font-size: 1.4rem; }
        .uptime { color: #aa55ff; }

        .progress-container {
            margin-top: 15px;
            position: relative;
        }

        .progress-bar {
            width: 100%;
            height: 8px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 4px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--accent), var(--secondary));
            border-radius: 4px;
            transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
            width: 0%;
            box-shadow: 0 0 15px var(--accent-glow);
        }

        .log {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 15px;
            font-family: 'Fira Code', 'Consolas', monospace;
            font-size: 0.8rem;
            max-height: 250px;
            overflow-y: auto;
            color: #777;
            scrollbar-width: thin;
            scrollbar-color: var(--border) transparent;
        }

        .log::-webkit-scrollbar { width: 6px; }
        .log::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

        .log-entry { 
            margin-bottom: 6px;
            padding-left: 10px;
            border-left: 2px solid transparent;
            transition: all 0.2s;
        }
        .log-entry:hover { 
            color: #eee;
            border-left-color: var(--accent);
            background: rgba(255,255,255,0.02);
        }

        .pulse {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--accent);
            box-shadow: 0 0 10px var(--accent);
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 255, 136, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(0, 255, 136, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 255, 136, 0); }
        }

        .footer {
            margin-top: 40px;
            text-align: center;
            color: #444;
            font-size: 0.75rem;
            letter-spacing: 1px;
            text-transform: uppercase;
        }

        .difficulty { 
            color: #ff8844; 
            font-size: 0.9rem; 
            font-family: monospace;
            word-break: break-all;
            opacity: 0.8;
        }

        .tag {
            padding: 4px 10px;
            border-radius: 100px;
            font-size: 0.7rem;
            font-weight: 700;
            text-transform: uppercase;
            background: rgba(255,255,255,0.05);
            margin-left: 10px;
        }

        @media (max-width: 600px) {
            .header { flex-direction: column; align-items: flex-start; gap: 10px; }
            h1 { font-size: 1.8rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>HASH Miner</h1>
                <p class="subtitle"><span class="pulse"></span> Live GPU Monitoring</p>
            </div>
            <div class="tag">Mainnet v0.1.0</div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-label">Hash Rate</div>
                <div class="card-value hash-rate" id="hashRate">-- H/s</div>
            </div>
            <div class="card">
                <div class="card-label">Total Attempts</div>
                <div class="card-value attempts" id="attempts">--</div>
            </div>
            <div class="card">
                <div class="card-label">Successes</div>
                <div class="card-value hash-rate" id="successCount">0</div>
            </div>
            <div class="card">
                <div class="card-label">Round Time</div>
                <div class="card-value" id="roundTime">-- s</div>
            </div>
            <div class="card">
                <div class="card-label">Epoch / Blocks Left</div>
                <div class="card-value epoch"><span id="epoch">--</span> / <span id="blocksLeft" style="font-size: 1rem; color: #888;">--</span></div>
            </div>
            <div class="card">
                <div class="card-label">Status</div>
                <div class="card-value status" id="status">Loading...</div>
            </div>
        </div>

        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));">
            <div class="card">
                <div class="card-label">Era</div>
                <div class="card-value uptime" id="era">--</div>
            </div>
            <div class="card">
                <div class="card-label">Reward</div>
                <div class="card-value attempts" id="reward">-- HASH</div>
            </div>
            <div class="card">
                <div class="card-label">Minted Progress</div>
                <div class="card-value uptime"><span id="minted">--</span> / <span id="totalToMint">--</span></div>
            </div>
            <div class="card">
                <div class="card-label">Uptime</div>
                <div class="card-value uptime" id="uptime">--</div>
            </div>
        </div>

        <div class="card" style="margin-bottom: 15px; border-left: 4px solid #00ff88;">
            <div class="card-label">Miner Address</div>
            <div id="minerAddress" style="font-family: monospace; color: #00ff88; word-break: break-all; font-size: 0.9rem;">--</div>
        </div>

        <div class="card" style="margin-bottom: 15px; border-left: 4px solid #aa55ff;">
            <div class="card-label">Hardware: <span id="gpuDevice" style="color: #fff; text-transform: none;">Detecting...</span></div>
            <div style="font-size: 0.9rem; color: #888; margin-top: 5px;">
                Batch Size: <span id="gpuBatch" style="color: #00ccff;">--</span> nonces/dispatch
            </div>
        </div>

        <div class="card" style="margin-bottom: 15px;">
            <div class="card-label">Difficulty</div>
            <div class="card-value difficulty" id="difficulty">--</div>
            <div class="progress-bar">
                <div class="progress-fill" id="progress"></div>
            </div>
        </div>

        <div class="card">
            <div class="card-label">Challenge</div>
            <div id="challenge" style="font-family: monospace; color: #888; word-break: break-all;">--</div>
        </div>

        <div style="margin-top: 15px;">
            <div class="card-label">Recent Activity</div>
            <div class="log" id="log"></div>
        </div>

        <div class="footer">
            HASH Token GPU Miner | Alchemy RPC | Auto-refresh every 2s
        </div>
    </div>

    <script>
        const logEl = document.getElementById('log');
        let logEntries = [];

        function formatNumber(n) {
            if (n === null || n === undefined || isNaN(n)) return '--';
            if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
            return n.toLocaleString();
        }

        function formatDuration(ms) {
            const seconds = Math.floor((ms / 1000) % 60);
            const minutes = Math.floor((ms / (1000 * 60)) % 60);
            const hours = Math.floor(ms / (1000 * 60 * 60));
            return \`\${hours}h \${minutes}m \${seconds}s\`;
        }

        function addLog(msg) {
            const time = new Date().toLocaleTimeString();
            logEntries.unshift(\`[\${time}] \${msg}\`);
            if (logEntries.length > 50) logEntries.pop();
            logEl.innerHTML = logEntries.map(e => \`<div class="log-entry">\${e}</div>\`).join('');
        }

        async function fetchStats() {
            try {
                const res = await fetch('/api/stats');
                const data = await res.json();

                document.getElementById('hashRate').textContent = formatNumber(data.hashRate) + ' H/s';
                document.getElementById('attempts').textContent = formatNumber(data.attempts);
                document.getElementById('successCount').textContent = data.successCount;
                document.getElementById('roundTime').textContent = data.roundTime + ' s';
                document.getElementById('epoch').textContent = data.epoch;
                document.getElementById('blocksLeft').textContent = data.blocksLeft + ' left';
                document.getElementById('status').textContent = data.status;
                document.getElementById('difficulty').textContent = data.difficulty ? data.difficulty.toString().slice(0, 30) + '...' : '--';
                document.getElementById('challenge').textContent = data.challenge || '--';
                
                // New details
                document.getElementById('era').textContent = data.era;
                document.getElementById('reward').textContent = data.reward ? data.reward.toFixed(4) + ' HASH' : '--';
                document.getElementById('minted').textContent = formatNumber(data.minted);
                document.getElementById('totalToMint').textContent = formatNumber(data.totalToMint);
                document.getElementById('gpuDevice').textContent = data.gpuDevice;
                document.getElementById('gpuBatch').textContent = formatNumber(data.gpuBatch);
                document.getElementById('uptime').textContent = formatDuration(Date.now() - data.startTime);
                document.getElementById('minerAddress').textContent = data.minerAddress;

                // Progress bar (minted vs total)
                if (data.totalToMint > 0) {
                    const progress = (data.minted / data.totalToMint) * 100;
                    document.getElementById('progress').style.width = progress + '%';
                }

                if (data.status && data.status !== 'Initializing...' && data.status !== 'Mining') {
                    if (logEntries[0] && !logEntries[0].includes(data.status)) {
                        addLog(data.status);
                    }
                    
                    // Notification Logic
                    if (data.status.includes('Minted successfully!') && (!window.lastNotifiedSuccess || window.lastNotifiedSuccess < data.lastSuccess)) {
                        window.lastNotifiedSuccess = data.lastSuccess;
                        
                        // Play Sound
                        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2013/2013-preview.mp3');
                        audio.play().catch(e => console.log('Audio play blocked by browser policy.'));
                        
                        if (Notification.permission === 'granted') {
                            new Notification('🎉 HASH MINTED!', { body: 'Found a block!' });
                        }
                        alert('🎉 SUCCESS! You successfully minted a HASH token!');
                    }
                }
            } catch (e) {
                console.error('Fetch error:', e);
            }
        }

        fetchStats();
        setInterval(fetchStats, 2000);
    </script>
</body>
</html>`;

// HTTP Server
const server = http.createServer((req, res) => {
  if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(currentStats));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardHTML);
  }
});

const PORT = process.env.DASHBOARD_PORT || 3456;
server.listen(PORT, () => {
  console.log(`[Dashboard] Server running at http://localhost:${PORT}`);
  console.log(`[Dashboard] Open http://localhost:${PORT} in your browser`);
});

// Start miner
const miner = startMiner();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Dashboard] Shutting down...');
  miner.kill('SIGINT');
  server.close(() => process.exit(0));
});
