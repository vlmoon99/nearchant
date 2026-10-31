mod common;
use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const ROOT_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async fn setup() -> anyhow::Result<(Env, Contract, Account, Account)> {
    let env = base().await?;
    let billing = deploy(&env.root, "billing", "billing").await?;
    let treasury = sub(&env.root, "treasury", 5).await?;
    billing.call("new").args_json(json!({"owner_id": env.root.id(), "relayer_id": env.relayer.id(),
        "token_id": env.nusd.id(), "treasury_id": treasury.id()})).transact().await?.into_result()?;
    for id in [billing.id(), treasury.id()] {
        env.relayer.call(env.nusd.id(), "register").args_json(json!({"account_id": id})).transact().await?.into_result()?;
    }
    let alice = sub(&env.root, "alice", 10).await?;
    fund(&env, &alice).await?;
    Ok((env, billing, alice, treasury))
}

async fn top_up(env: &Env, billing: &Contract, who: &Account, amount: u128) -> anyhow::Result<()> {
    who.call(env.nusd.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": billing.id(), "amount": amount.to_string(), "msg": r#"{"action":"top_up"}"#}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    Ok(())
}

async fn acct(billing: &Contract, who: &Account) -> anyhow::Result<Value> {
    Ok(billing.view("get_account").args_json(json!({"account_id": who.id()})).await?.json()?)
}

fn batch(id: &str, who: &Account, amount: u128) -> Value {
    json!({"batch_id": id, "merkle_root": ROOT_A, "entries": [{"account_id": who.id(), "amount": amount.to_string()}]})
}

#[tokio::test]
async fn top_up_settle_sweep_withdraw() -> anyhow::Result<()> {
    let (env, billing, alice, treasury) = setup().await?;
    top_up(&env, &billing, &alice, 10 * ONE_NUSD).await?;
    assert_eq!(acct(&billing, &alice).await?["balance"], (10 * ONE_NUSD).to_string());

    let charged: String = env.relayer.call(billing.id(), "settle_batch").args_json(batch("b1", &alice, 3 * ONE_NUSD))
        .transact().await?.into_result()?.json()?;
    assert_eq!(charged, (3 * ONE_NUSD).to_string());
    // Re-sending the same batch charges nothing more.
    env.relayer.call(billing.id(), "settle_batch").args_json(batch("b1", &alice, 3 * ONE_NUSD))
        .transact().await?.into_result()?;
    assert_eq!(acct(&billing, &alice).await?["balance"], (7 * ONE_NUSD).to_string());
    let b: Value = billing.view("get_batch").args_json(json!({"batch_id": "b1"})).await?.json()?;
    assert_eq!(b["merkle_root"], ROOT_A);

    env.root.call(billing.id(), "sweep").max_gas().transact().await?.into_result()?;
    assert_eq!(balance(&env.nusd, treasury.id()).await?, 3 * ONE_NUSD);

    alice.call(billing.id(), "withdraw").args_json(json!({"amount": (2 * ONE_NUSD).to_string()}))
        .max_gas().transact().await?.into_result()?;
    assert_eq!(acct(&billing, &alice).await?["balance"], (5 * ONE_NUSD).to_string());
    assert_eq!(balance(&env.nusd, alice.id()).await?, 92 * ONE_NUSD);
    let over = alice.call(billing.id(), "withdraw").args_json(json!({"amount": (6 * ONE_NUSD).to_string()}))
        .max_gas().transact().await?;
    assert!(over.is_failure());
    Ok(())
}

#[tokio::test]
async fn caps_and_balance_limit_charges_and_report_unpaid() -> anyhow::Result<()> {
    let (env, billing, alice, _t) = setup().await?;
    top_up(&env, &billing, &alice, 10 * ONE_NUSD).await?;
    alice.call(billing.id(), "set_caps").args_json(json!({"daily": (4 * ONE_NUSD).to_string(), "monthly": "0"}))
        .transact().await?.into_result()?;
    let r = env.relayer.call(billing.id(), "settle_batch").args_json(batch("b1", &alice, 6 * ONE_NUSD))
        .transact().await?.into_result()?;
    assert_eq!(r.json::<String>()?, (4 * ONE_NUSD).to_string(), "daily cap stops the charge");
    assert!(r.logs().iter().any(|l| l.contains("\"unpaid\":\"2000000\"")));

    alice.call(billing.id(), "set_caps").args_json(json!({"daily": "0", "monthly": "0"})).transact().await?.into_result()?;
    let r: String = env.relayer.call(billing.id(), "settle_batch").args_json(batch("b2", &alice, 50 * ONE_NUSD))
        .transact().await?.into_result()?.json()?;
    assert_eq!(r, (6 * ONE_NUSD).to_string(), "balance stops the charge");
    assert_eq!(acct(&billing, &alice).await?["balance"], "0");
    Ok(())
}

#[tokio::test]
async fn only_relayer_settles_and_root_must_be_hex() -> anyhow::Result<()> {
    let (env, billing, alice, _t) = setup().await?;
    top_up(&env, &billing, &alice, 10 * ONE_NUSD).await?;
    let r = alice.call(billing.id(), "settle_batch").args_json(batch("b1", &alice, ONE_NUSD)).transact().await?;
    assert!(r.is_failure());
    let r = env.relayer.call(billing.id(), "settle_batch")
        .args_json(json!({"batch_id": "b1", "merkle_root": "nothex", "entries": []})).transact().await?;
    assert!(r.is_failure());
    Ok(())
}
