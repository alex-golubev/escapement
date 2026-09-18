// SPDX-License-Identifier: Apache-2.0
//
// The engine boundary in Rust. Everything here is generated from
// schema/boundary.toml by `cargo xtask generate`; nothing hand-written belongs
// in this crate (ADR-0016), and CI fails on a difference (ADR-0013).

#![no_std]

mod generated;

pub use generated::*;
