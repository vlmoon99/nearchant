//! `handles` — the handle factory, deployed on the platform root account (`nearchant.testnet`).
//! A handle is both a NEAR subaccount (`alice.<root>`) and a web name (`alice.nearchant.com`).
//! The seller's own key is the full-access key; the platform keeps none. Spec: docs/contracts.md.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, Allowance, NearToken, PanicOnDefault, Promise, PromiseError,
    PublicKey,
};

const MAX_ORIGINS: usize = 20;
const MAX_LINKS: usize = 10;
const MAX_TEXT: usize = 600;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub name: String,
    pub bio: String,
    pub avatar_hash: Option<String>,
    pub links: Vec<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Pending,
    Active,
    Suspended,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Handle {
    pub handle: String,
    pub owner_id: AccountId,
    pub account_id: AccountId,
    pub payout_account_id: AccountId,
    pub payout_token_id: Option<AccountId>,
    pub card: Card,
    pub gateway_url: Option<String>,
    pub embed_origins: Vec<String>,
    pub status: Status,
    pub created_at: U64,
    pub card_published_at: Option<U64>,
}

/// A function-call key added to a sponsored seller account for the seller's agents.
#[near(serializers = [json])]
pub struct AgentKey {
    pub public_key: PublicKey,
    pub receiver_id: AccountId,
    pub method_names: Vec<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    relayer_id: AccountId,
    handles: LookupMap<String, Handle>,
    by_owner: LookupMap<AccountId, Vec<String>>,
    reserved: LookupSet<String>,
    /// Contracts an agent key may target (orders, proofs, escrow).
    agent_receivers: Vec<AccountId>,
    /// NEAR given to a sponsored account (claim_for).
    sponsor_amount: NearToken,
    /// Minimum attached deposit for a self-paid claim.
    min_claim_deposit: NearToken,
    /// Gas allowance of each agent key.
    agent_key_allowance: NearToken,
}

pub const DEFAULT_RESERVED: &[&str] = &[
    "www", "app", "api", "admin", "embed", "cdn", "docs", "status", "mail", "auth", "pay",
    "checkout", "support", "help", "escrow", "proofs", "billing", "orders", "agents", "envs",
    "treasury", "relayer", "nusd", "handles", "market", "near", "nearchant", "root", "system",
];

fn event(name: &str, data: serde_json::Value) {
    let ev = json!({"standard": "nearchant", "version": "1.0.0", "event": name, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

/// 2–32 chars of a-z 0-9 - _, starting and ending with a letter or digit, no doubled separators
/// (also a valid NEAR account label, and no dots so it is one DNS label).
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() < 2 || b.len() > 32 {
        return false;
    }
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let sep = |c: u8| c == b'-' || c == b'_';
    if !alnum(b[0]) || !alnum(b[b.len() - 1]) {
        return false;
    }
    b.iter().all(|&c| alnum(c) || sep(c)) && !b.windows(2).any(|w| sep(w[0]) && sep(w[1]))
}

fn valid_origin(o: &str) -> bool {
    (o.starts_with("https://") || o.starts_with("http://localhost") || o.starts_with("http://127.0.0.1"))
        && o.len() <= 200
        && !o.contains('*')
        && !o.ends_with('/')
}

fn check_card(card: &Card) {
    require!(card.name.len() <= 80, "card name too long");
    require!(card.bio.len() <= MAX_TEXT, "card bio too long");
    require!(card.links.len() <= MAX_LINKS, "too many links");
    require!(card.links.iter().all(|l| l.starts_with("https://") && l.len() <= 200), "links must be https");
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, relayer_id: AccountId, agent_receivers: Vec<AccountId>) -> Self {
        let mut reserved = LookupSet::new(b"r");
        for n in DEFAULT_RESERVED {
            reserved.insert(n.to_string());
        }
        Self {
            owner_id,
            relayer_id,
            handles: LookupMap::new(b"h"),
            by_owner: LookupMap::new(b"o"),
            reserved,
            agent_receivers,
            sponsor_amount: NearToken::from_millinear(200),
            min_claim_deposit: NearToken::from_millinear(100),
            agent_key_allowance: NearToken::from_millinear(250),
        }
    }

    // ---- claiming ----

    /// Creates `<handle>.<this account>` with `public_key` as its full-access key, funded with the
    /// attached deposit. The caller owns the record.
    #[payable]
    pub fn claim(&mut self, handle: String, public_key: PublicKey, card: Card) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= self.min_claim_deposit, "attach at least min_claim_deposit");
        let owner = env::predecessor_account_id();
        self.start_claim(handle, owner, public_key, card, deposit, vec![], Some(env::predecessor_account_id()))
    }

    /// Sponsored claim (testnet, ADR 0001): the platform pays `sponsor_amount`. The new account owns
    /// its own record. Optional agent keys are function-call keys to platform contracts only.
    pub fn claim_for(
        &mut self,
        handle: String,
        public_key: PublicKey,
        card: Card,
        agent_keys: Option<Vec<AgentKey>>,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.relayer_id, "relayer only");
        let account_id = self.account_for(&handle);
        let keys = agent_keys.unwrap_or_default();
        for k in &keys {
            require!(self.agent_receivers.contains(&k.receiver_id), "agent key receiver not allowed");
            require!(!k.method_names.is_empty(), "agent key needs method names");
        }
        self.start_claim(handle, account_id, public_key, card, self.sponsor_amount, keys, None)
    }

    /// Maps a handle to an account the caller already owns; no subaccount is created.
    pub fn link(&mut self, handle: String, card: Card) {
        let account_id = env::predecessor_account_id();
        self.check_available(&handle);
        check_card(&card);
        let record = self.new_record(&handle, account_id.clone(), account_id, card, Status::Active);
        self.insert(record);
        event("handle_claimed", json!({"handle": handle, "account_id": env::predecessor_account_id(), "linked": true}));
    }

    #[private]
    pub fn on_claim_created(
        &mut self,
        handle: String,
        refund_to: Option<AccountId>,
        refund: NearToken,
        #[callback_result] created: Result<(), PromiseError>,
    ) -> bool {
        if created.is_ok() {
            if let Some(h) = self.handles.get_mut(&handle) {
                h.status = Status::Active;
                let account_id = h.account_id.clone();
                event("handle_claimed", json!({"handle": handle, "account_id": account_id, "linked": false}));
            }
            true
        } else {
            if let Some(h) = self.handles.remove(&handle) {
                self.remove_from_owner(&h.owner_id, &handle);
            }
            if let Some(to) = refund_to {
                Promise::new(to).transfer(refund).detach();
            }
            false
        }
    }

    // ---- owner-of-handle updates ----

    pub fn set_card(&mut self, handle: String, card: Card) {
        check_card(&card);
        let h = self.owned_mut(&handle);
        h.card = card;
        h.card_published_at = Some(U64(env::block_timestamp()));
        event("handle_updated", json!({"handle": handle, "fields": ["card"]}));
    }

    pub fn set_payout(&mut self, handle: String, account_id: AccountId, token_id: Option<AccountId>) {
        let h = self.owned_mut(&handle);
        h.payout_account_id = account_id;
        h.payout_token_id = token_id;
        event("handle_updated", json!({"handle": handle, "fields": ["payout"]}));
    }

    pub fn set_gateway_url(&mut self, handle: String, gateway_url: Option<String>) {
        if let Some(u) = &gateway_url {
            require!(u.starts_with("https://") && u.len() <= 200, "gateway_url must be https");
        }
        self.owned_mut(&handle).gateway_url = gateway_url;
        event("handle_updated", json!({"handle": handle, "fields": ["gateway_url"]}));
    }

    pub fn set_embed_origins(&mut self, handle: String, origins: Vec<String>) {
        require!(origins.len() <= MAX_ORIGINS, "too many origins");
        require!(origins.iter().all(|o| valid_origin(o)), "origins must be exact https:// (or localhost) origins");
        self.owned_mut(&handle).embed_origins = origins;
        event("handle_updated", json!({"handle": handle, "fields": ["embed_origins"]}));
    }

    // ---- platform admin ----

    pub fn add_reserved(&mut self, names: Vec<String>) {
        self.assert_owner();
        for n in names {
            self.reserved.insert(n);
        }
    }

    pub fn suspend(&mut self, handle: String, reason: String) {
        self.assert_owner();
        self.handles.get_mut(&handle).expect("no such handle").status = Status::Suspended;
        event("handle_suspended", json!({"handle": handle, "reason": reason}));
    }

    pub fn unsuspend(&mut self, handle: String) {
        self.assert_owner();
        let h = self.handles.get_mut(&handle).expect("no such handle");
        require!(h.status == Status::Suspended, "not suspended");
        h.status = Status::Active;
        event("handle_unsuspended", json!({"handle": handle}));
    }

    pub fn set_params(
        &mut self,
        relayer_id: Option<AccountId>,
        agent_receivers: Option<Vec<AccountId>>,
        sponsor_amount: Option<NearToken>,
        min_claim_deposit: Option<NearToken>,
    ) {
        self.assert_owner();
        if let Some(v) = relayer_id { self.relayer_id = v; }
        if let Some(v) = agent_receivers { self.agent_receivers = v; }
        if let Some(v) = sponsor_amount { self.sponsor_amount = v; }
        if let Some(v) = min_claim_deposit { self.min_claim_deposit = v; }
    }

    // ---- views ----

    /// Only `Active` handles; pending and suspended ones read as missing (404 card).
    pub fn get_handle(&self, handle: String) -> Option<Handle> {
        self.handles.get(&handle).filter(|h| h.status == Status::Active).cloned()
    }

    /// Any status, for the owner's dashboard and admin tools.
    pub fn get_handle_any(&self, handle: String) -> Option<Handle> {
        self.handles.get(&handle).cloned()
    }

    pub fn get_handles_by_owner(&self, account_id: AccountId) -> Vec<String> {
        self.by_owner.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn is_reserved(&self, name: String) -> bool {
        self.reserved.contains(&name)
    }

    pub fn is_available(&self, name: String) -> bool {
        valid_name(&name) && !self.reserved.contains(&name) && !self.handles.contains_key(&name)
    }

    // ---- internals ----

    #[allow(clippy::too_many_arguments)]
    fn start_claim(
        &mut self,
        handle: String,
        owner_id: AccountId,
        public_key: PublicKey,
        card: Card,
        funding: NearToken,
        agent_keys: Vec<AgentKey>,
        refund_to: Option<AccountId>,
    ) -> Promise {
        self.check_available(&handle);
        check_card(&card);
        let account_id = self.account_for(&handle);
        let record = self.new_record(&handle, owner_id, account_id.clone(), card, Status::Pending);
        self.insert(record);

        let mut p = Promise::new(account_id)
            .create_account()
            .transfer(funding)
            .add_full_access_key(public_key);
        for k in agent_keys {
            p = p.add_access_key_allowance(
                k.public_key,
                Allowance::limited(self.agent_key_allowance).expect("non-zero allowance"),
                k.receiver_id,
                k.method_names.join(","),
            );
        }
        p.then(Self::ext(env::current_account_id()).on_claim_created(handle, refund_to, funding))
    }

    fn account_for(&self, handle: &str) -> AccountId {
        format!("{}.{}", handle, env::current_account_id()).parse().expect("valid account id")
    }

    fn check_available(&self, handle: &str) {
        require!(valid_name(handle), "invalid handle name");
        require!(!self.reserved.contains(handle), "handle is reserved");
        require!(!self.handles.contains_key(handle), "handle is taken");
    }

    fn new_record(&self, handle: &str, owner_id: AccountId, account_id: AccountId, card: Card, status: Status) -> Handle {
        Handle {
            handle: handle.to_string(),
            owner_id,
            payout_account_id: account_id.clone(),
            account_id,
            payout_token_id: None,
            card,
            gateway_url: None,
            embed_origins: vec![],
            status,
            created_at: U64(env::block_timestamp()),
            card_published_at: None,
        }
    }

    fn insert(&mut self, h: Handle) {
        let mut list = self.by_owner.get(&h.owner_id).cloned().unwrap_or_default();
        list.push(h.handle.clone());
        self.by_owner.insert(h.owner_id.clone(), list);
        self.handles.insert(h.handle.clone(), h);
    }

    fn remove_from_owner(&mut self, owner: &AccountId, handle: &str) {
        if let Some(list) = self.by_owner.get_mut(owner) {
            list.retain(|x| x != handle);
        }
    }

    fn owned_mut(&mut self, handle: &str) -> &mut Handle {
        let caller = env::predecessor_account_id();
        let h = self.handles.get_mut(handle).expect("no such handle");
        require!(h.owner_id == caller || h.account_id == caller, "not the handle owner");
        require!(h.status == Status::Active, "handle not active");
        h
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }
}
