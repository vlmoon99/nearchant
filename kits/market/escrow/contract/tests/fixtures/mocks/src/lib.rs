//! TEST ONLY: a stand-in handle registry (`get_handle`) and proof log (`is_passed`) for the sandbox tests.
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId, PanicOnDefault};

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct HandleView {
    pub account_id: AccountId,
    pub payout_account_id: AccountId,
}

#[near(serializers = [borsh])]
pub struct Proof {
    subject: String,
    author_id: AccountId,
    passed: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    handles: LookupMap<String, HandleView>,
    proofs: LookupMap<u64, Proof>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self { handles: LookupMap::new(b"h"), proofs: LookupMap::new(b"p") }
    }

    pub fn set_handle(&mut self, handle: String, account_id: AccountId, payout_account_id: AccountId) {
        self.handles.insert(handle, HandleView { account_id, payout_account_id });
    }

    pub fn get_handle(&self, handle: String) -> Option<HandleView> {
        self.handles.get(&handle).cloned()
    }

    pub fn set_proof(&mut self, proof_id: U64, subject: String, author_id: AccountId, passed: bool) {
        self.proofs.insert(proof_id.0, Proof { subject, author_id, passed });
    }

    pub fn is_passed(&self, proof_id: U64, subject: String, author_id: AccountId) -> bool {
        self.proofs.get(&proof_id.0).is_some_and(|p| p.passed && p.subject == subject && p.author_id == author_id)
    }
}
