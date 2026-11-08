//! `proof-log` — an append-only log of content fingerprints on NEAR.
//!
//! Each entry says: the content with this hash (`content_hash`, e.g. sha256 hex) existed at this block time,
//! the account that wrote the entry is `author_id`, and (optionally) what produced it (`producer`, e.g.
//! `model:qwen3`), what it is about (`subject`, e.g. a post or order id), a review result (`passed`) and
//! free-form `metadata` JSON. Entries are never changed or deleted.
//!
//! Anyone may write; the author is always the caller, so readers trust an entry only if its author is the
//! party they expect. The writer pays the storage its entry uses (attach a deposit; the excess is refunded).

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

const MAX_LIST: u32 = 100;

/// What the writer sends.
#[near(serializers = [json])]
pub struct NewEntry {
    /// Fingerprint of the content, e.g. sha256 hex (1..=128 chars).
    pub content_hash: String,
    /// Who or what made the content, e.g. `model:qwen3` or `camera:pixel8` (≤ 200 chars).
    pub producer: Option<String>,
    /// What the content is about, e.g. `post:123` or an order id (≤ 128 chars).
    pub subject: Option<String>,
    /// A review/check result, if there was one. `Some(false)` makes `is_passed` false.
    pub passed: Option<bool>,
    /// Free-form JSON (≤ 2048 bytes), e.g. `{"caption_sha256": "…", "image_sha256": "…"}`.
    pub metadata: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: U64,
    pub author_id: AccountId,
    pub content_hash: String,
    pub producer: Option<String>,
    pub subject: Option<String>,
    pub passed: Option<bool>,
    pub metadata: Option<String>,
    /// Block timestamp in nanoseconds.
    pub created_at: U64,
    pub block_height: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    entries: LookupMap<u64, Entry>,
    next_id: u64,
    /// author -> how many entries; (author, n) -> entry id. Keeps per-author listing O(page), not O(history).
    author_count: LookupMap<AccountId, u64>,
    by_author: LookupMap<(AccountId, u64), u64>,
    hash_count: LookupMap<String, u64>,
    by_hash: LookupMap<(String, u64), u64>,
}

fn check_len(s: &str, max: usize, what: &str) {
    require!(!s.is_empty() && s.len() <= max, format!("{what} must be 1..={max} chars"));
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new() -> Self {
        Self {
            entries: LookupMap::new(b"e"),
            next_id: 1,
            author_count: LookupMap::new(b"a"),
            by_author: LookupMap::new(b"b"),
            hash_count: LookupMap::new(b"h"),
            by_hash: LookupMap::new(b"i"),
        }
    }

    /// Appends an entry and returns its id. Attach enough NEAR for the storage (about 0.01 NEAR is plenty for
    /// a typical entry); the unused part is refunded in the same call.
    #[payable]
    pub fn record(&mut self, entry: NewEntry) -> U64 {
        check_len(&entry.content_hash, 128, "content_hash");
        if let Some(p) = &entry.producer { check_len(p, 200, "producer"); }
        if let Some(s) = &entry.subject { check_len(s, 128, "subject"); }
        if let Some(m) = &entry.metadata {
            check_len(m, 2048, "metadata");
            require!(serde_json::from_str::<serde_json::Value>(m).is_ok(), "metadata must be JSON");
        }

        let before = env::storage_usage();
        let id = self.next_id;
        self.next_id += 1;
        let author = env::predecessor_account_id();
        let e = Entry {
            id: U64(id),
            author_id: author.clone(),
            content_hash: entry.content_hash,
            producer: entry.producer,
            subject: entry.subject,
            passed: entry.passed,
            metadata: entry.metadata,
            created_at: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
        };
        let n = self.author_count.get(&author).copied().unwrap_or(0);
        self.author_count.insert(author.clone(), n + 1);
        self.by_author.insert((author, n), id);
        let h = self.hash_count.get(&e.content_hash).copied().unwrap_or(0);
        self.hash_count.insert(e.content_hash.clone(), h + 1);
        self.by_hash.insert((e.content_hash.clone(), h), id);
        let ev = json!({"standard": "proof_log", "version": "1.0.0", "event": "proof_recorded", "data": [{
            "id": e.id, "author_id": e.author_id, "content_hash": e.content_hash, "subject": e.subject,
            "passed": e.passed,
        }]});
        self.entries.insert(id, e);
        self.entries.flush();
        self.author_count.flush();
        self.by_author.flush();
        self.hash_count.flush();
        self.by_hash.flush();

        // The writer pays for the bytes the entry added; anything extra goes back.
        let cost = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
        let refund = attached.saturating_sub(cost);
        if refund > NearToken::from_yoctonear(0) {
            Promise::new(env::predecessor_account_id()).transfer(refund).detach();
        }
        env::log_str(&format!("EVENT_JSON:{ev}"));
        U64(id)
    }

    pub fn get(&self, id: U64) -> Option<Entry> {
        self.entries.get(&id.0).cloned()
    }

    /// The id the next entry will get (entries so far = next_id - 1).
    pub fn get_next_id(&self) -> U64 {
        U64(self.next_id)
    }

    pub fn count_by_author(&self, author_id: AccountId) -> U64 {
        U64(self.author_count.get(&author_id).copied().unwrap_or(0))
    }

    /// An author's entries, oldest first. `limit` is capped at 100.
    pub fn list_by_author(&self, author_id: AccountId, from_index: Option<U64>, limit: Option<u32>) -> Vec<Entry> {
        let total = self.author_count.get(&author_id).copied().unwrap_or(0);
        let from = from_index.map_or(0, |v| v.0);
        let limit = limit.unwrap_or(MAX_LIST).min(MAX_LIST) as u64;
        (from..total.min(from.saturating_add(limit)))
            .filter_map(|n| self.by_author.get(&(author_id.clone(), n)))
            .filter_map(|id| self.entries.get(id).cloned())
            .collect()
    }

    /// Every entry with this fingerprint, oldest first (the first one is the earliest proof). `limit` ≤ 100.
    pub fn find_by_hash(&self, content_hash: String, from_index: Option<U64>, limit: Option<u32>) -> Vec<Entry> {
        let total = self.hash_count.get(&content_hash).copied().unwrap_or(0);
        let from = from_index.map_or(0, |v| v.0);
        let limit = limit.unwrap_or(MAX_LIST).min(MAX_LIST) as u64;
        (from..total.min(from.saturating_add(limit)))
            .filter_map(|n| self.by_hash.get(&(content_hash.clone(), n)))
            .filter_map(|id| self.entries.get(id).cloned())
            .collect()
    }

    /// True only if the entry exists, is about `subject`, was written by `author_id`, and did not fail review.
    /// This is what the escrow kit calls before it lets a seller mark an order delivered.
    pub fn is_passed(&self, proof_id: U64, subject: String, author_id: AccountId) -> bool {
        self.entries.get(&proof_id.0).is_some_and(|e| {
            e.passed != Some(false) && e.subject.as_deref() == Some(subject.as_str()) && e.author_id == author_id
        })
    }
}
