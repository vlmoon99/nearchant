//! `proof-log` — per task: hashes of brief, producer (model or workflow), output, attestation ref,
//! and the review result. Anyone may write; the author is the caller, and consumers trust an entry
//! only if its author is the party they expect (`orders` checks author == seller account).

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Review {
    pub passed: bool,
    pub reviewer_hash: String,
}

/// What the writer sends.
#[near(serializers = [json])]
pub struct NewEntry {
    pub task_id: String,
    pub order_id: Option<String>,
    pub brief_hash: String,
    /// `model:<id>` or `workflow:<id>@<hash>`
    pub producer: String,
    pub output_hash: String,
    pub attestation_ref: Option<String>,
    pub review: Review,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub proof_id: U64,
    pub author_id: AccountId,
    pub task_id: String,
    pub order_id: Option<String>,
    pub brief_hash: String,
    pub producer: String,
    pub output_hash: String,
    pub attestation_ref: Option<String>,
    pub review: Review,
    pub created_at: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    entries: LookupMap<u64, Entry>,
    next_id: u64,
}

fn short(s: &str, max: usize, what: &str) {
    require!(!s.is_empty() && s.len() <= max, format!("{what} must be 1..={max} chars"));
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new() -> Self {
        Self { entries: LookupMap::new(b"e"), next_id: 1 }
    }

    pub fn record(&mut self, entry: NewEntry) -> U64 {
        short(&entry.task_id, 128, "task_id");
        short(&entry.brief_hash, 128, "brief_hash");
        short(&entry.producer, 200, "producer");
        short(&entry.output_hash, 128, "output_hash");
        short(&entry.review.reviewer_hash, 128, "reviewer_hash");
        if let Some(o) = &entry.order_id { short(o, 128, "order_id"); }
        if let Some(a) = &entry.attestation_ref { short(a, 400, "attestation_ref"); }

        let id = self.next_id;
        self.next_id += 1;
        let e = Entry {
            proof_id: U64(id),
            author_id: env::predecessor_account_id(),
            task_id: entry.task_id,
            order_id: entry.order_id,
            brief_hash: entry.brief_hash,
            producer: entry.producer,
            output_hash: entry.output_hash,
            attestation_ref: entry.attestation_ref,
            review: entry.review,
            created_at: U64(env::block_timestamp()),
        };
        let ev = json!({"standard": "nearchant", "version": "1.0.0", "event": "proof_recorded", "data": [{
            "proof_id": e.proof_id, "author_id": e.author_id, "task_id": e.task_id, "order_id": e.order_id,
            "output_hash": e.output_hash, "passed": e.review.passed,
        }]});
        env::log_str(&format!("EVENT_JSON:{ev}"));
        self.entries.insert(id, e);
        U64(id)
    }

    pub fn get_next_id(&self) -> U64 {
        U64(self.next_id)
    }

    pub fn get(&self, proof_id: U64) -> Option<Entry> {
        self.entries.get(&proof_id.0).cloned()
    }

    /// True only if the entry exists, passed review, is for `order_id`, and was written by `author_id`.
    pub fn is_passed(&self, proof_id: U64, order_id: String, author_id: AccountId) -> bool {
        self.entries.get(&proof_id.0).is_some_and(|e| {
            e.review.passed && e.order_id.as_deref() == Some(order_id.as_str()) && e.author_id == author_id
        })
    }
}
