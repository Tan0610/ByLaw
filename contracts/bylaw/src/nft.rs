//! NEP-171 (core), NEP-177 (metadata), NEP-181 (enumeration) for agent and seat NFTs.
//! Agent NFT owner receives the agent's earnings; seat NFT owner receives seat dividends.
//! Seat transfers checkpoint the seat_accumulator first. Retired agents cannot be transferred.
use crate::events;
use crate::types::*;
use crate::{promise_ok, Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, PromiseOrValue,
};

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NFTContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    /// JSON: {"kind":"agent",...} or {"kind":"seat",...}
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
}

#[ext_contract(ext_nft_receiver)]
pub trait NonFungibleTokenReceiver {
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool>;
}

fn parse_token_id(s: &str) -> u64 {
    s.parse::<u64>()
        .unwrap_or_else(|_| env::panic_str("token_id must be a decimal integer"))
}

#[near]
impl Contract {
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approval_id.is_none(), "approvals are not supported");
        let _ = memo;
        let id = parse_token_id(&token_id);
        let sender = env::predecessor_account_id();
        self.internal_nft_transfer(&sender, &receiver_id, id);
    }

    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_one_yocto();
        require!(approval_id.is_none(), "approvals are not supported");
        let _ = memo;
        let id = parse_token_id(&token_id);
        let sender = env::predecessor_account_id();
        self.internal_nft_transfer(&sender, &receiver_id, id);
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_tgas(30))
            .nft_on_transfer(sender.clone(), sender.clone(), token_id.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .nft_resolve_transfer(sender, receiver_id, token_id),
            )
            .into()
    }

    /// Returns true if the token stays with the receiver.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
    ) -> bool {
        let id = parse_token_id(&token_id);
        let must_return = if promise_ok() {
            match env::promise_result_checked(0, 64) {
                Ok(v) => serde_json::from_slice::<bool>(&v).unwrap_or(true),
                Err(_) => true,
            }
        } else {
            true
        };
        if !must_return {
            return true;
        }
        if self.nft_owner.get(&id) != Some(&receiver_id) {
            return true; // receiver already moved it on
        }
        if self.seats.contains_key(&id) {
            self.internal_checkpoint(id);
        }
        self.nft_owner.insert(id, previous_owner_id.clone());
        events::nft_transfer(receiver_id.as_str(), previous_owner_id.as_str(), id);
        false
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        let id = token_id.parse::<u64>().ok()?;
        self.token_view(id)
    }

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "ByLaw agents and seats".to_string(),
            symbol: "BYLAW".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.nft_owner.len() as u128)
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let mut ids: Vec<u64> = self.nft_owner.keys().copied().collect();
        ids.sort();
        let start = from_index.map(|f| f.0 as usize).unwrap_or(0);
        let lim = limit.unwrap_or(100).min(200) as usize;
        ids.into_iter()
            .skip(start)
            .take(lim)
            .filter_map(|id| self.token_view(id))
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(
            self.nft_owner
                .values()
                .filter(|o| **o == account_id)
                .count() as u128,
        )
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let mut ids: Vec<u64> = self
            .nft_owner
            .iter()
            .filter(|(_, o)| **o == account_id)
            .map(|(id, _)| *id)
            .collect();
        ids.sort();
        let start = from_index.map(|f| f.0 as usize).unwrap_or(0);
        let lim = limit.unwrap_or(100).min(200) as usize;
        ids.into_iter()
            .skip(start)
            .take(lim)
            .filter_map(|id| self.token_view(id))
            .collect()
    }
}

impl Contract {
    pub(crate) fn internal_nft_transfer(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        id: u64,
    ) {
        let owner = self.owner_of(id);
        require!(&owner == sender, "sender must be the token owner");
        require!(sender != receiver, "receiver must differ from sender");
        if let Some(a) = self.agents.get(&id) {
            require!(
                a.state != AgentState::Retired,
                "retired agent NFTs cannot be transferred"
            );
        }
        if self.seats.contains_key(&id) {
            // credit dividends accrued so far to the current owner before ownership moves
            self.internal_checkpoint(id);
        }
        self.nft_owner.insert(id, receiver.clone());
        events::nft_transfer(sender.as_str(), receiver.as_str(), id);
    }

    fn token_view(&self, id: u64) -> Option<Token> {
        let owner = self.nft_owner.get(&id)?.clone();
        let (title, extra) = if let Some(a) = self.agents.get(&id) {
            (
                format!("ByLaw agent #{} ({})", id, a.kind.as_str()),
                json!({
                    "kind": "agent",
                    "role": a.kind.as_str(),
                    "account": a.account,
                    "rep": a.rep,
                    "state": a.state,
                    "delivered": a.delivered,
                    "rejected": a.rejected,
                })
                .to_string(),
            )
        } else if let Some(s) = self.seats.get(&id) {
            (
                format!("ByLaw seat #{}", id),
                json!({"kind": "seat", "weight": s.weight, "pending": self.pending_of(s).to_string()}).to_string(),
            )
        } else {
            return None;
        };
        Some(Token {
            token_id: id.to_string(),
            owner_id: owner,
            metadata: Some(TokenMetadata {
                title: Some(title),
                description: None,
                media: None,
                media_hash: None,
                copies: Some(1),
                issued_at: None,
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: Some(extra),
                reference: None,
                reference_hash: None,
            }),
        })
    }
}
