use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alloy::network::EthereumWallet;
use alloy::primitives::{address, keccak256, Address, B256, U256};
use alloy::providers::{Provider, ProviderBuilder, WsConnect};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use eyre::{eyre, Result};
use rand::Rng;

#[cfg(feature = "gpu")]
mod gpu;

const HASH_CONTRACT_ADDRESS: Address = address!("AC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc");
const DEFAULT_RPC_URL: &str = "https://eth.llamarpc.com";
const EPOCH_BLOCKS: u64 = 100; // matches contract constant
const EPOCH_POLL_INTERVAL: Duration = Duration::from_secs(15);
const STATS_INTERVAL: Duration = Duration::from_secs(2);
const ERA_MINTS: u64 = 100_000;

sol! {
    #[sol(rpc)]
    contract HashToken {
        // Public storage getters
        function currentDifficulty() external view returns (uint256);
        function totalMints() external view returns (uint256);
        function totalMiningMinted() external view returns (uint256);
        function genesisComplete() external view returns (bool);

        // Helpers
        function getChallenge(address miner) external view returns (bytes32);
        function epochBlocksLeft() external view returns (uint256);
        function currentReward() external view returns (uint256);
        function miningState() external view returns (
            uint256 era,
            uint256 reward,
            uint256 difficulty,
            uint256 minted,
            uint256 remaining,
            uint256 epoch,
            uint256 epochBlocksLeft
        );

        // Mining entry-point: NO challenge arg, contract recomputes it.
        function mine(uint256 nonce) external;

        // ERC20
        function totalSupply() external view returns (uint256);
    }
}

struct Solution {
    nonce: U256,
    epoch: u64,
}

#[inline]
fn check_proof(challenge: &B256, nonce: U256, difficulty: U256) -> bool {
    // Contract: keccak256(abi.encode(bytes32 challenge, uint256 nonce))
    // For bytes32 + uint256, abi.encode produces exactly 64 packed bytes
    // (each field is already 32 bytes, no padding needed).
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(challenge.as_slice());
    buf[32..].copy_from_slice(&nonce.to_be_bytes::<32>());
    let hash = keccak256(buf);
    U256::from_be_bytes::<32>(hash.0) < difficulty
}

/// Run N CPU workers in a scoped thread pool. Each thread iterates nonces with
/// stride = num_threads so no two threads ever hash the same nonce.
fn run_workers(
    challenge: B256,
    difficulty: U256,
    epoch: u64,
    start_nonce: U256,
    stop_flag: Arc<AtomicBool>,
    attempts_counter: Arc<AtomicU64>,
    num_threads: usize,
) -> Option<Solution> {
    let solution_slot: Mutex<Option<Solution>> = Mutex::new(None);
    let stride = U256::from(num_threads);

    std::thread::scope(|s| {
        for tid in 0..num_threads {
            let stop_flag = &stop_flag;
            let attempts_counter = &attempts_counter;
            let solution_slot = &solution_slot;
            s.spawn(move || {
                let mut nonce = start_nonce + U256::from(tid);
                let mut local_attempts: u64 = 0;
                loop {
                    if check_proof(&challenge, nonce, difficulty) {
                        let mut slot = solution_slot.lock().unwrap();
                        if slot.is_none() {
                            *slot = Some(Solution { nonce, epoch });
                        }
                        stop_flag.store(true, Ordering::Relaxed);
                        attempts_counter.fetch_add(local_attempts, Ordering::Relaxed);
                        return;
                    }
                    nonce += stride;
                    local_attempts += 1;

                    if local_attempts & 0x3FFF == 0 {
                        attempts_counter.fetch_add(local_attempts, Ordering::Relaxed);
                        local_attempts = 0;
                        if stop_flag.load(Ordering::Relaxed) {
                            return;
                        }
                    }
                }
            });
        }
    });

    solution_slot.into_inner().ok().flatten()
}

fn reward_for_total_mints(total_mints: U256) -> u128 {
    let era = total_mints / U256::from(ERA_MINTS);
    if era < U256::from(64u64) {
        100u128 >> era.to::<u128>().min(63)
    } else {
        0
    }
}

fn hex_short(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(16);
    for b in bytes.iter().take(8) {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    // Load .env if present (ignore if missing — env vars still work).
    let _ = dotenvy::dotenv();

    println!("🔐 HASH Token CPU Miner (Rust)");
    println!("================================\n");

    let raw_key = match std::env::var("PRIVATE_KEY") {
        Ok(v) => v,
        Err(_) => {
            println!("⚠️  No PRIVATE_KEY env var found.");
            rpassword::prompt_password("Private Key: ")?
        }
    };
    let key_trimmed = raw_key.trim().trim_start_matches("0x");
    if key_trimmed.len() != 64 {
        return Err(eyre!("Invalid private key length (expected 64 hex chars)"));
    }
    let signer: PrivateKeySigner = key_trimmed.parse()?;
    let miner_address = signer.address();
    let wallet = EthereumWallet::from(signer);

    let rpc_url_str = std::env::var("RPC_URL").unwrap_or_else(|_| DEFAULT_RPC_URL.to_string());
    
    // --- Dynamic Provider Setup (WS or HTTP) ---
    let provider = if rpc_url_str.starts_with("ws") {
        println!("🌐 Connecting via Websocket for real-time updates...");
        let ws_connect = WsConnect::new(rpc_url_str);
        ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_ws(ws_connect)
            .await?
    } else {
        println!("🌐 Connecting via HTTP (polling mode)...");
        ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_http(rpc_url_str.parse()?)
    };

    let contract = HashToken::new(HASH_CONTRACT_ADDRESS, provider.clone());

    let num_threads = std::env::var("MINER_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or_else(num_cpus::get);

    println!("🔨 HASH Miner initialized");
    println!("📍 Miner Address: {}", miner_address);
    println!("🧵 Worker threads: {}", num_threads);

    // --- Initial info via miningState() ---
    match contract.miningState().call().await {
        Ok(s) => {
            println!("\n📋 Mining State:");
            println!("   Era: {}", s.era);
            println!("   Reward: {} (raw, 1e18)", s.reward);
            println!("   Difficulty: {}", s.difficulty);
            println!("   Mining minted: {} / {}", s.minted, s.minted + s.remaining);
            println!("   Current epoch: {}", s.epoch);
            println!("   Blocks left in epoch: {}", s.epochBlocksLeft);
        }
        Err(e) => eprintln!("⚠️  miningState() failed: {e}"),
    }

    match contract.genesisComplete().call().await {
        Ok(g) if !g._0 => {
            return Err(eyre!(
                "Genesis is not complete yet — mining is closed."
            ));
        }
        Ok(_) => println!("✅ Genesis complete — mining is open"),
        Err(e) => eprintln!("⚠️  Could not verify genesisComplete: {e}"),
    }

    // --- Optional GPU backend ---
    let gpu_enabled = std::env::var("GPU").ok().as_deref() == Some("1");
    #[cfg(feature = "gpu")]
    let gpu_miner: Option<Arc<gpu::GpuMiner>> = if gpu_enabled {
        let batch = std::env::var("GPU_BATCH")
            .ok()
            .and_then(|s| s.parse::<usize>().ok());
        match gpu::GpuMiner::new(batch) {
            Ok(g) => {
                println!("🎮 GPU device: {}", g.device_name());
                println!("🎮 GPU batch size: {} nonces/dispatch", g.batch_size());
                match g.self_test() {
                    Ok(()) => println!("✅ GPU self-test passed"),
                    Err(e) => return Err(eyre!("GPU self-test FAILED — aborting: {e}")),
                }
                Some(Arc::new(g))
            }
            Err(e) => {
                eprintln!("⚠️  GPU init failed, falling back to CPU: {e}");
                None
            }
        }
    } else {
        None
    };
    #[cfg(not(feature = "gpu"))]
    let gpu_miner: Option<()> = None;

    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let shutdown = Arc::clone(&shutdown);
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                println!("\n🛑 Ctrl-C received, stopping...");
                shutdown.store(true, Ordering::Relaxed);
            }
        });
    }

    // --- Start real-time block subscription if on WS ---
    use futures_util::StreamExt;
    let mut block_stream = if provider.supports_subscriptions() {
        match provider.subscribe_blocks().await {
            Ok(sub) => {
                println!("📡 Subscribed to new blocks for instant epoch switching.");
                Some(sub.into_stream())
            }
            Err(e) => {
                eprintln!("⚠️  Failed to subscribe to blocks: {e}. Falling back to polling.");
                None
            }
        }
    } else {
        None
    };

    let session_start = Instant::now();
    let mut session_attempts: u64 = 0;
    let mut success_count: u64 = 0;

    while !shutdown.load(Ordering::Relaxed) {
        // 1. Get current state
        let block_num = match provider.get_block_number().await {
            Ok(n) => n,
            Err(e) => {
                eprintln!("❌ RPC error: {e}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        let epoch: u64 = block_num / EPOCH_BLOCKS;

        let challenge = match contract.getChallenge(miner_address).call().await {
            Ok(v) => v._0,
            Err(e) => {
                eprintln!("❌ Challenge error: {e}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        let difficulty = match contract.currentDifficulty().call().await {
            Ok(v) => v._0,
            Err(e) => {
                eprintln!("❌ Difficulty error: {e}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        println!("\n📊 Round start:");
        println!("   Block: {}  Epoch: {}", block_num, epoch);
        println!("   Difficulty: {}", difficulty);
        println!("   Challenge: 0x{}", hex_short(challenge.as_slice()));
        println!("⛏️  Mining epoch {} on {} ({} threads)...", epoch, if gpu_miner.is_some() { "GPU" } else { "CPU" }, num_threads);

        let stop_flag = Arc::new(AtomicBool::new(false));
        let attempts_counter = Arc::new(AtomicU64::new(0));

        // --- Watchdog & Stats ---
        let watchdog = {
            let stop_flag = Arc::clone(&stop_flag);
            let attempts_counter = Arc::clone(&attempts_counter);
            let shutdown = Arc::clone(&shutdown);
            let round_start = Instant::now();
            tokio::spawn(async move {
                let mut last_print = Instant::now();
                let mut last_attempts: u64 = 0;
                loop {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if stop_flag.load(Ordering::Relaxed) || shutdown.load(Ordering::Relaxed) {
                        break;
                    }

                    if last_print.elapsed() >= STATS_INTERVAL {
                        let total = attempts_counter.load(Ordering::Relaxed);
                        let delta = total.saturating_sub(last_attempts);
                        let rate = delta as f64 / last_print.elapsed().as_secs_f64();
                        eprint!(
                            "\r⚡ {:>10.2} H/s | round {:>6.0}s | attempts {:>14}",
                            rate, round_start.elapsed().as_secs_f64(), total
                        );
                        last_attempts = total;
                        last_print = Instant::now();
                    }
                }
            })
        };

        // --- Block Monitor (The instant switcher) ---
        let block_monitor = {
            let stop_flag = Arc::clone(&stop_flag);
            let provider = provider.clone();
            let target_epoch = epoch;
            let mut stream = block_stream.take(); // Take the stream if it exists
            
            tokio::spawn(async move {
                if let Some(mut s) = stream {
                    while let Some(header) = s.next().await {
                        let bn = header.number;
                        if bn / EPOCH_BLOCKS != target_epoch {
                            println!("\n🔄 New block {} -> New Epoch! Restarting...", bn);
                            stop_flag.store(true, Ordering::Relaxed);
                            return Some(s); // Return stream for next round
                        }
                    }
                    None
                } else {
                    // Polling fallback
                    loop {
                        tokio::time::sleep(EPOCH_POLL_INTERVAL).await;
                        if stop_flag.load(Ordering::Relaxed) { break; }
                        if let Ok(bn) = provider.get_block_number().await {
                            if bn / EPOCH_BLOCKS != target_epoch {
                                println!("\n🔄 Block {} (Polling) -> New Epoch!", bn);
                                stop_flag.store(true, Ordering::Relaxed);
                                break;
                            }
                        }
                    }
                    None
                }
            })
        };

        // --- Mining Execution ---
        let start_nonce_u64: u64 = rand::thread_rng().gen();
        let gpu_m = gpu_miner.clone();
        let stop_f = Arc::clone(&stop_flag);
        let att_c = Arc::clone(&attempts_counter);

        let mining_result: Option<Solution> = tokio::task::spawn_blocking(move || {
            #[cfg(feature = "gpu")]
            if let Some(g) = gpu_m {
                return match g.mine(challenge, difficulty, start_nonce_u64, stop_f, att_c) {
                    Ok(Some(n)) => Some(Solution { nonce: U256::from(n), epoch }),
                    _ => None,
                };
            }
            
            run_workers(challenge, difficulty, epoch, U256::from(start_nonce_u64), stop_f, att_c, num_threads)
        }).await?;

        stop_flag.store(true, Ordering::Relaxed);
        let _ = watchdog.await;
        // Put the stream back for the next round
        block_stream = block_monitor.await?;
        
        session_attempts += attempts_counter.load(Ordering::Relaxed);
        eprintln!();

        if let Some(sol) = mining_result {
            println!("🎉 FOUND NONCE: {} (epoch {})", sol.nonce, sol.epoch);

            let priority_gwei: f64 = std::env::var("PRIORITY_GWEI").ok().and_then(|s| s.parse().ok()).unwrap_or(5.0);
            let max_fee_gwei: f64 = std::env::var("MAX_FEE_GWEI").ok().and_then(|s| s.parse().ok()).unwrap_or(100.0);
            
            let mut tx = contract.mine(sol.nonce)
                .max_priority_fee_per_gas((priority_gwei * 1e9) as u128)
                .max_fee_per_gas((max_fee_gwei * 1e9) as u128);

            if let Some(g) = std::env::var("GAS_LIMIT_OVERRIDE").ok().and_then(|s| s.parse().ok()) {
                tx = tx.gas(g);
            }

            match tx.send().await {
                Ok(pending) => {
                    println!("📋 TX: {}", pending.tx_hash());
                    if let Ok(receipt) = pending.with_required_confirmations(1).get_receipt().await {
                        if receipt.status() {
                            println!("✅ SUCCESS in block {}", receipt.block_number.unwrap_or_default());
                            success_count += 1;
                        } else { println!("❌ REVERTED"); }
                    }
                }
                Err(e) => eprintln!("❌ FAILED: {e}"),
            }
        }
    }

    let elapsed = session_start.elapsed().as_secs_f64().max(0.001);
    let rate = session_attempts as f64 / elapsed;
    println!("\n📊 Final Statistics:");
    println!("   Total Attempts: {session_attempts}");
    println!("   Successful Mints: {success_count}");
    println!("   Average Hash Rate: {rate:.2} H/s");
    println!("   Mining Duration: {elapsed:.2} seconds");
    Ok(())
}
