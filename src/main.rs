//! gray-pi — registered entry point for the pi-extension bridge.
//!
//! The bridge itself is `gray-pi.mjs` (a Node sidecar — pi extensions are
//! TypeScript and need real Node semantics; embedding a JS engine would
//! break the 1:1 guarantee). This binary materializes that script under
//! $GRAY_HOME/pi/runtime-<ver>.mjs on first run and then `exec`s node with
//! it, replacing this process outright — one process total, no proxy hop.
//! Same pattern as gray-subagents' embedded Python supervisor.
//!
//! `setup` also seeds the node_modules symlink farms + jiti; run it once
//! after install (`gray-pi setup`).

use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

const RUNTIME: &str = include_str!("../gray-pi.mjs");
const RUNTIME_VER: &str = "0.1.0";

fn home() -> PathBuf {
    std::env::var_os("GRAY_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".gray")))
        .expect("no GRAY_HOME/HOME")
}

fn main() {
    let pi_dir = home().join("pi");
    std::fs::create_dir_all(&pi_dir).expect("cannot create pi dir");
    let runtime = pi_dir.join(format!("runtime-{RUNTIME_VER}.mjs"));
    let stale = std::fs::read_to_string(&runtime).map_or(true, |s| s != RUNTIME);
    if stale {
        std::fs::write(&runtime, RUNTIME).expect("cannot write runtime.mjs");
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `exec` replaces this process — the registered binary *becomes* node.
    let err = Command::new("node").arg(&runtime).args(&args).exec();
    eprintln!("gray-pi: cannot exec node: {err} (need node >= 22.18 on PATH)");
    std::process::exit(127);
}
