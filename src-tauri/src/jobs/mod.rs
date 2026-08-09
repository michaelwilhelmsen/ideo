//! In-flight work (PRD §3.3).
//!
//! The user is charged the moment fal accepts a job, so a job that only exists
//! in a running process is money staked on the app not being quit. Everything
//! here follows from that: `fal` knows how to talk to the queue, `store` writes
//! down what has been submitted before the first poll, and `runner` owns the
//! lifecycle — submit, watch, resume, cancel — so a resumed job and a fresh one
//! are the same loop rather than two.
//!
//! The split against `projects` is deliberate. Disk holds the *recipe*, which
//! is the expensive artefact (PRD §1); this database holds only what is in
//! flight, so losing it costs a poll rather than a recipe.

pub mod fal;
pub mod image_input;
pub mod runner;
pub mod store;
