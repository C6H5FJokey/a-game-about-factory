use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=DAYBREAK_CONTENT_CONFIG");
    println!("cargo:rerun-if-changed=../scripts/content.mjs");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output")).join("content.rs");
    let status = Command::new("node")
        .arg("../scripts/content.mjs")
        .arg("--rust")
        .arg(out)
        .status()
        .expect("Node.js is required to generate the content catalog");
    assert!(status.success(), "content catalog generation failed");
}
