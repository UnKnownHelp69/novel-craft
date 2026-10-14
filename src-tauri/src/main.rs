// Release builds on Windows use the GUI subsystem, so no console window opens next to the
// app. Debug builds keep the console for eprintln! output (e.g. a failed backup).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    novelcraft_lib::run();
}
