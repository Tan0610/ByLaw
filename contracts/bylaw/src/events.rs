//! NEP-297 events. ByLaw events use standard "bylaw" version "1.0.0" with field names
//! exactly as in docs/INTERFACES.md section 2.1. NFT events use standard "nep171" 1.2.0.
use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "bylaw";
pub const VERSION: &str = "1.0.0";

pub fn emit_std(standard: &str, version: &str, event: &str, data: Value) {
    let v = json!({
        "standard": standard,
        "version": version,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", v));
}

pub fn emit(event: &str, data: Value) {
    emit_std(STANDARD, VERSION, event, data);
}

pub fn nft_mint(owner: &str, token_id: u64) {
    emit_std(
        "nep171",
        "1.2.0",
        "nft_mint",
        json!({"owner_id": owner, "token_ids": [token_id.to_string()]}),
    );
}

pub fn nft_transfer(old_owner: &str, new_owner: &str, token_id: u64) {
    emit_std(
        "nep171",
        "1.2.0",
        "nft_transfer",
        json!({"old_owner_id": old_owner, "new_owner_id": new_owner, "token_ids": [token_id.to_string()]}),
    );
}
