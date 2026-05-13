const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
  lastUpdate: Date.now()
};

// Parse miner output
function parseLine(line) {
  // Hash rate line: "⚡ 4223747.64 H/s | round     80s | attempts      179470336"
  const hashRateMatch = line.match(/⚡\s+([\d.,]+)\s+H\/s/);
  const roundTimeMatch = line.match(/round\s+([\d.]+)s/);
  const attemptsMatch = line.match(/attempts\s+([\d,]+)/);

  if (hashRateMatch) {
    currentStats.hashRate = parseFloat(hashRateMatch[1].replace(/,/g, ''));
    currentStats.roundTime = roundTimeMatch ? parseFloat(roundTimeMatch[1]) : 0;
    currentStats.attempts = attemptsMatch ? parseInt(attemptsMatch[1].replace(/,/g, '')) : 0;
    currentStats.status = 'Mining';
    currentStats.lastUpdate = Date.now();
  }

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

  // Success: "🎉 FOUND VALID NONCE"
  if (line.includes('FOUND VALID NONCE')) {
    currentStats.status = 'Found nonce! Submitting...';
  }
  if (line.includes('SUCCESS')) {
    currentStats.status = 'Minted successfully!';
    currentStats.lastSuccess = Date.now();
  }
  if (line.includes('Transaction reverted')) {
    currentStats.status = 'Transaction reverted';
  }

  // Epoch changed
  if (line.includes('Epoch changed')) {
    currentStats.status = 'Epoch changed, restarting...';
  }

  // RPC errors
  if (line.includes('RPC error') || line.includes('block poll failed')) {
    currentStats.status = 'RPC error - retrying';
  }
}

// Start the miner
function startMiner() {
  const minerPath = path.join(__dirname, 'target', 'release', 'hash-miner-rs.exe');

  console.log('[Dashboard] Starting miner...');
  const miner = spawn(minerPath, [], {
    env: {
      ...process.env,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
      RPC_URL: process.env.RPC_URL,
      MINER_THREADS: process.env.MINER_THREADS || '8'
    },
    cwd: __dirname
  });

  miner.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        parseLine(line);
        console.log('[Miner]', line.trim());
      }
    });
  });

  miner.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        parseLine(line);
        console.log('[Miner]', line.trim());
      }
    });
  });

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
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: #0a0a0f;
            color: #e0e0e0;
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 900px; margin: 0 auto; }
        h1 {
            font-size: 2rem;
            background: linear-gradient(135deg, #00ff88, #00ccff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 10px;
        }
        .subtitle { color: #888; margin-bottom: 30px; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .card {
            background: #12121a;
            border: 1px solid #1e1e2e;
            border-radius: 12px;
            padding: 20px;
            transition: border-color 0.3s;
        }
        .card:hover { border-color: #00ff88; }
        .card-label {
            color: #888;
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
        }
        .card-value {
            font-size: 1.6rem;
            font-weight: 700;
            color: #fff;
        }
        .hash-rate { color: #00ff88; }
        .attempts { color: #00ccff; }
        .epoch { color: #ffaa00; }
        .status { color: #ff55aa; }
        .uptime { color: #aa55ff; }
        .progress-bar {
            width: 100%;
            height: 6px;
            background: #1e1e2e;
            border-radius: 3px;
            overflow: hidden;
            margin-top: 10px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #00ff88, #00ccff);
            border-radius: 3px;
            transition: width 0.5s ease;
            width: 0%;
        }
        .log {
            background: #12121a;
            border: 1px solid #1e1e2e;
            border-radius: 12px;
            padding: 15px;
            font-family: 'Consolas', monospace;
            font-size: 0.85rem;
            max-height: 200px;
            overflow-y: auto;
            color: #aaa;
        }
        .log-entry { margin-bottom: 4px; }
        .pulse {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #00ff88;
            margin-right: 8px;
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(0.8); }
        }
        .footer {
            margin-top: 20px;
            text-align: center;
            color: #555;
            font-size: 0.8rem;
        }
        .difficulty { color: #ff8844; }
    </style>
</head>
<body>
    <div class="container">
        <h1>HASH Miner Dashboard</h1>
        <p class="subtitle"><span class="pulse"></span>Live monitoring</p>

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
                <div class="card-label">Round Time</div>
                <div class="card-value" id="roundTime">-- s</div>
            </div>
            <div class="card">
                <div class="card-label">Epoch</div>
                <div class="card-value epoch" id="epoch">--</div>
            </div>
            <div class="card">
                <div class="card-label">Block</div>
                <div class="card-value" id="block">--</div>
            </div>
            <div class="card">
                <div class="card-label">Status</div>
                <div class="card-value status" id="status">Loading...</div>
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
            HASH Token CPU Miner | Alchemy RPC | Auto-refresh every 2s
        </div>
    </div>

    <script>
        const logEl = document.getElementById('log');
        let logEntries = [];

        function formatNumber(n) {
            if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
            return n.toLocaleString();
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
                document.getElementById('roundTime').textContent = data.roundTime + ' s';
                document.getElementById('epoch').textContent = data.epoch;
                document.getElementById('block').textContent = data.block;
                document.getElementById('status').textContent = data.status;
                document.getElementById('difficulty').textContent = data.difficulty ? data.difficulty.toString().slice(0, 20) + '...' : '--';
                document.getElementById('challenge').textContent = data.challenge || '--';

                // Progress bar (attempts vs difficulty - rough visualization)
                const progress = Math.min((data.attempts / 1e12) * 100, 100);
                document.getElementById('progress').style.width = progress + '%';

                if (data.status && data.status !== 'Initializing...') {
                    addLog(data.status);
                    
                    // Notification Logic
                    if (data.status.includes('Minted successfully!') && !window.lastNotifiedSuccess || window.lastNotifiedSuccess < data.lastSuccess) {
                        window.lastNotifiedSuccess = data.lastSuccess;
                        
                        // Play Sound
                        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2013/2013-preview.mp3');
                        audio.play().catch(e => console.log('Audio play blocked by browser policy until user interacts.'));
                        
                        // Browser Alert
                        if (Notification.permission === 'granted') {
                            new Notification('🎉 HASH MINTED!', { body: 'Check your wallet, you just found a block!' });
                        } else if (Notification.permission !== 'denied') {
                            Notification.requestPermission();
                        }
                        alert('🎉 SUCCESS! You successfully minted a HASH token!');
                    }
                }
            } catch (e) {
                console.error('Fetch error:', e);
                addLog('Connection lost, retrying...');
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
