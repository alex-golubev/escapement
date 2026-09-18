// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace chores, run as `cargo xtask <task>`. The boundary generator of
// ADR-0013 lands here; until schema/ exists there is nothing to generate.

use std::process::ExitCode;

fn main() -> ExitCode {
    let task = std::env::args().nth(1);
    match task.as_deref() {
        Some("tasks") | None => {
            println!("usage: cargo xtask <task>");
            println!();
            println!("tasks:");
            println!("  tasks    list the tasks (this message)");
            ExitCode::SUCCESS
        }
        Some(unknown) => {
            eprintln!("xtask: unknown task {unknown:?}, try `cargo xtask tasks`");
            ExitCode::FAILURE
        }
    }
}
