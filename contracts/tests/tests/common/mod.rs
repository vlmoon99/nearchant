#![allow(dead_code)]
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;

pub const ONE_NUSD: u128 = 1_000_000;

/// Reads a contract built by `make contracts` (cargo near build).
pub fn wasm(name: &str) -> Vec<u8> {
    let n = name.replace("-", "_");
    let path = format!("{}/../target/near/{n}/{n}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|_| panic!("missing {path}: run `make contracts` first"))
}

pub async fn sub(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

pub async fn deploy(root: &Account, name: &str, crate_name: &str) -> anyhow::Result<Contract> {
    let acc = sub(root, name, 30).await?;
    Ok(acc.deploy(&wasm(crate_name)).await?.into_result()?)
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub relayer: Account,
    pub nusd: Contract,
}

/// Sandbox with a platform root, a relayer and an initialised nUSD.
pub async fn base() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let relayer = sub(&root, "relayer", 20).await?;
    let nusd = deploy(&root, "nusd", "nusd").await?;
    nusd.call("new")
        .args_json(json!({"owner_id": root.id(), "relayer_id": relayer.id()}))
        .transact()
        .await?
        .into_result()?;
    Ok(Env { worker, root, relayer, nusd })
}

pub async fn balance(nusd: &Contract, who: &near_workspaces::AccountId) -> anyhow::Result<u128> {
    let v: String = nusd.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(v.parse()?)
}

/// Faucet money for an account (registers it too).
pub async fn fund(env: &Env, who: &Account) -> anyhow::Result<()> {
    who.call(env.nusd.id(), "faucet").transact().await?.into_result()?;
    Ok(())
}
