fn main() {
    println!("cargo:rerun-if-env-changed=KUBIKI_UPDATER_PUBLIC_KEY");
    tauri_build::build()
}
