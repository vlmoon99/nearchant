//! `nusd` — Nearchant TEST dollar. NEP-141 + NEP-145 + NEP-148, 6 decimals, with a faucet.
//! Free test money for the demo (ADR 0001). Mainnet uses real USDC instead; nothing depends on `faucet`.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LazyOption, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

/// 1 nUSD in base units (6 decimals).
pub const ONE_NUSD: u128 = 1_000_000;
const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    Metadata,
    LastClaim,
}

#[near(serializers = [json])]
pub struct FaucetConfig {
    pub amount: U128,
    pub period_ns: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,
    relayer_id: AccountId,
    faucet_amount: u128,
    faucet_period_ns: u64,
    last_claim: LookupMap<AccountId, u64>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, relayer_id: AccountId) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Nearchant TEST dollar".to_string(),
            symbol: "nUSD".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        };
        Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata: LazyOption::new(StorageKey::Metadata, Some(metadata)),
            owner_id,
            relayer_id,
            faucet_amount: 100 * ONE_NUSD,
            faucet_period_ns: DAY_NS,
            last_claim: LookupMap::new(StorageKey::LastClaim),
        }
    }

    /// Mints the faucet amount to the caller, once per period. The contract pays the storage.
    pub fn faucet(&mut self) -> U128 {
        self.mint_from_faucet(env::predecessor_account_id())
    }

    /// Same as `faucet`, for a sponsored account. Relayer only.
    pub fn faucet_for(&mut self, account_id: AccountId) -> U128 {
        require!(env::predecessor_account_id() == self.relayer_id, "relayer only");
        self.mint_from_faucet(account_id)
    }

    /// Registers an account for free (contract pays storage). Relayer or owner only;
    /// used for platform contracts and sponsored accounts that must receive nUSD.
    pub fn register(&mut self, account_id: AccountId) {
        let caller = env::predecessor_account_id();
        require!(caller == self.relayer_id || caller == self.owner_id, "relayer or owner only");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
    }

    pub fn set_faucet(&mut self, amount: U128, period_ns: U64) {
        self.assert_owner();
        self.faucet_amount = amount.0;
        self.faucet_period_ns = period_ns.0;
    }

    pub fn set_relayer(&mut self, relayer_id: AccountId) {
        self.assert_owner();
        self.relayer_id = relayer_id;
    }

    pub fn faucet_config(&self) -> FaucetConfig {
        FaucetConfig { amount: U128(self.faucet_amount), period_ns: U64(self.faucet_period_ns) }
    }

    /// When `account_id` may use the faucet again (0 = now).
    pub fn faucet_available_at(&self, account_id: AccountId) -> U64 {
        U64(self.last_claim.get(&account_id).map_or(0, |t| t + self.faucet_period_ns))
    }

    fn mint_from_faucet(&mut self, account_id: AccountId) -> U128 {
        let now = env::block_timestamp();
        if let Some(last) = self.last_claim.get(&account_id) {
            require!(now >= last + self.faucet_period_ns, "faucet: already claimed in this period");
        }
        self.last_claim.insert(account_id.clone(), now);
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        let amount = self.faucet_amount;
        self.token.internal_deposit(&account_id, amount);
        FtMint { owner_id: &account_id, amount: U128(amount), memo: Some("faucet") }.emit();
        U128(amount)
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("burned {} from closed account {}", burned, sender_id);
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().clone().expect("metadata")
    }
}
