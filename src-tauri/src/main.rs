// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref()==Some("--kubiki-mcp-attach") {
        let path=std::env::args().nth(2).expect("Missing MCP bootstrap path");
        let runtime=tokio::runtime::Runtime::new().expect("MCP runtime");
        if let Err(error)=runtime.block_on(kubiki_mcp::attached::attach(std::path::Path::new(&path))) {eprintln!("{error}");std::process::exit(1);}
        return;
    }
    kubiki_lib::run()
}
