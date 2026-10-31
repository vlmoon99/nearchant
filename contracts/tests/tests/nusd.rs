mod common;
use common::*;
use serde_json::json;

#[tokio::test]
async fn faucet_mints_once_per_period() -> anyhow::Result<()> {
    let env = base().await?;
    let alice = sub(&env.root, "alice", 5).await?;

    alice.call(env.nusd.id(), "faucet").transact().await?.into_result()?;
    assert_eq!(balance(&env.nusd, alice.id()).await?, 100 * ONE_NUSD);

    let again = alice.call(env.nusd.id(), "faucet").transact().await?;
    assert!(again.is_failure(), "second claim in the same period must fail");
    assert_eq!(balance(&env.nusd, alice.id()).await?, 100 * ONE_NUSD);

    let meta: serde_json::Value = env.nusd.view("ft_metadata").await?.json()?;
    assert_eq!(meta["symbol"], "nUSD");
    assert_eq!(meta["decimals"], 6);
    Ok(())
}

#[tokio::test]
async fn faucet_period_can_be_shortened_by_owner_only() -> anyhow::Result<()> {
    let env = base().await?;
    let alice = sub(&env.root, "alice", 5).await?;
    let bad = alice.call(env.nusd.id(), "set_faucet")
        .args_json(json!({"amount": "1", "period_ns": "0"})).transact().await?;
    assert!(bad.is_failure());

    env.root.call(env.nusd.id(), "set_faucet")
        .args_json(json!({"amount": (5 * ONE_NUSD).to_string(), "period_ns": "0"}))
        .transact().await?.into_result()?;
    alice.call(env.nusd.id(), "faucet").transact().await?.into_result()?;
    alice.call(env.nusd.id(), "faucet").transact().await?.into_result()?;
    assert_eq!(balance(&env.nusd, alice.id()).await?, 10 * ONE_NUSD);
    Ok(())
}

#[tokio::test]
async fn faucet_for_and_register_are_relayer_only() -> anyhow::Result<()> {
    let env = base().await?;
    let mallory = sub(&env.root, "mallory", 5).await?;
    let bob: near_workspaces::AccountId = "bob.test.near".parse()?;

    let bad = mallory.call(env.nusd.id(), "faucet_for")
        .args_json(json!({"account_id": bob})).transact().await?;
    assert!(bad.is_failure());

    env.relayer.call(env.nusd.id(), "faucet_for")
        .args_json(json!({"account_id": bob})).transact().await?.into_result()?;
    assert_eq!(balance(&env.nusd, &bob).await?, 100 * ONE_NUSD);

    let bad = mallory.call(env.nusd.id(), "register")
        .args_json(json!({"account_id": "x.test.near"})).transact().await?;
    assert!(bad.is_failure());
    Ok(())
}

#[tokio::test]
async fn transfer_between_registered_accounts() -> anyhow::Result<()> {
    let env = base().await?;
    let alice = sub(&env.root, "alice", 5).await?;
    let bob = sub(&env.root, "bob", 5).await?;
    fund(&env, &alice).await?;
    env.relayer.call(env.nusd.id(), "register")
        .args_json(json!({"account_id": bob.id()})).transact().await?.into_result()?;

    alice.call(env.nusd.id(), "ft_transfer")
        .args_json(json!({"receiver_id": bob.id(), "amount": (7 * ONE_NUSD).to_string()}))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact().await?.into_result()?;
    assert_eq!(balance(&env.nusd, bob.id()).await?, 7 * ONE_NUSD);
    assert_eq!(balance(&env.nusd, alice.id()).await?, 93 * ONE_NUSD);
    Ok(())
}
