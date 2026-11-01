mod common;
use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

struct S {
    env: Env,
    escrow: Contract,
    owner: Account,
    agent: Account,
    market_agent: Account,
    treasury: Account,
}

async fn setup() -> anyhow::Result<S> {
    let env = base().await?;
    let escrow = deploy(&env.root, "escrow", "escrow-policy").await?;
    let treasury = sub(&env.root, "treasury", 5).await?;
    // Payees under `.nearchant.<root>` count as Nearchant sellers.
    let handles_root = sub(&env.root, "nearchant", 10).await?;
    escrow.call("new").args_json(json!({"owner_id": env.root.id(), "token_id": env.nusd.id(),
        "treasury_id": treasury.id(), "handles_root": handles_root.id()})).transact().await?.into_result()?;
    let owner = sub(&env.root, "alice", 10).await?;
    let agent = sub(&env.root, "alice-agent", 10).await?;
    let market_agent = sub(&env.root, "designer", 5).await?;
    for id in [escrow.id(), treasury.id(), market_agent.id()] {
        env.relayer.call(env.nusd.id(), "register").args_json(json!({"account_id": id})).transact().await?.into_result()?;
    }
    fund(&env, &owner).await?;
    let s = S { env, escrow, owner, agent, market_agent, treasury };
    let policy = json!({"auto_limit": (2 * ONE_NUSD).to_string(), "daily_limit": (3 * ONE_NUSD).to_string(),
        "allowlist": [s.market_agent.id()]});
    s.owner.call(s.env.nusd.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": s.escrow.id(), "amount": (10 * ONE_NUSD).to_string(),
            "msg": json!({"action": "fund", "campaign_id": "c1", "agent_id": s.agent.id(), "policy": policy}).to_string()}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    Ok(s)
}

async fn pay(s: &S, who: &Account, payee: &str, amount: u128) -> anyhow::Result<Option<Value>> {
    let r = who.call(s.escrow.id(), "pay")
        .args_json(json!({"campaign_id": "c1", "payee_id": payee, "amount": amount.to_string(), "memo": "slides"}))
        .max_gas().transact().await?;
    Ok(if r.is_success() { Some(r.json()?) } else { None })
}

async fn campaign(s: &S) -> anyhow::Result<Value> {
    Ok(s.escrow.view("get_campaign").args_json(json!({"campaign_id": "c1"})).await?.json()?)
}

#[tokio::test]
async fn auto_payment_within_policy() -> anyhow::Result<()> {
    let s = setup().await?;
    assert!(pay(&s, &s.owner, s.market_agent.id().as_str(), ONE_NUSD).await?.is_none(), "only the agent pays");
    let p = pay(&s, &s.agent, s.market_agent.id().as_str(), 2 * ONE_NUSD).await?.unwrap();
    assert_eq!(p["auto"], true);
    assert_eq!(balance(&s.env.nusd, s.market_agent.id()).await?, 2 * ONE_NUSD, "no fee for non-Nearchant payee");
    let c = campaign(&s).await?;
    assert_eq!(c["spent"], (2 * ONE_NUSD).to_string());
    assert_eq!(c["reserved"], "0");
    Ok(())
}

#[tokio::test]
async fn over_limit_or_off_allowlist_waits_for_approval() -> anyhow::Result<()> {
    let s = setup().await?;
    let big = pay(&s, &s.agent, s.market_agent.id().as_str(), 3 * ONE_NUSD).await?.unwrap();
    assert_eq!(big["status"], "Pending");
    let stranger = pay(&s, &s.agent, "stranger.test.near", ONE_NUSD).await?.unwrap();
    assert_eq!(stranger["status"], "Pending");
    assert_eq!(balance(&s.env.nusd, s.market_agent.id()).await?, 0);
    assert!(pay(&s, &s.agent, s.market_agent.id().as_str(), 7 * ONE_NUSD).await?.is_none(), "over remaining budget");

    let r = s.agent.call(s.escrow.id(), "approve").args_json(json!({"payment_id": big["payment_id"]})).max_gas().transact().await?;
    assert!(r.is_failure(), "agent can't approve");
    s.owner.call(s.escrow.id(), "approve").args_json(json!({"payment_id": big["payment_id"]})).max_gas().transact().await?.into_result()?;
    assert_eq!(balance(&s.env.nusd, s.market_agent.id()).await?, 3 * ONE_NUSD);
    s.owner.call(s.escrow.id(), "reject").args_json(json!({"payment_id": stranger["payment_id"]})).transact().await?.into_result()?;
    assert_eq!(campaign(&s).await?["reserved"], "0");
    Ok(())
}

#[tokio::test]
async fn daily_limit_counts_in_flight_payments() -> anyhow::Result<()> {
    let s = setup().await?;
    let a = pay(&s, &s.agent, s.market_agent.id().as_str(), 2 * ONE_NUSD).await?.unwrap();
    let b = pay(&s, &s.agent, s.market_agent.id().as_str(), 2 * ONE_NUSD).await?.unwrap();
    assert_eq!(a["auto"], true);
    assert_eq!(b["auto"], false, "2 + 2 > daily 3: second one waits");
    assert_eq!(b["status"], "Pending");
    Ok(())
}

#[tokio::test]
async fn nearchant_payee_pays_agent_fee_and_close_refunds() -> anyhow::Result<()> {
    let s = setup().await?;
    let seller = s.env.root.id();
    let bob: near_workspaces::AccountId = format!("bob.nearchant.{seller}").parse()?;
    s.env.relayer.call(s.env.nusd.id(), "register").args_json(json!({"account_id": bob})).transact().await?.into_result()?;
    s.owner.call(s.escrow.id(), "set_policy").args_json(json!({"campaign_id": "c1", "policy": {
        "auto_limit": (2 * ONE_NUSD).to_string(), "daily_limit": (3 * ONE_NUSD).to_string(), "allowlist": [bob]}}))
        .transact().await?.into_result()?;
    pay(&s, &s.agent, bob.as_str(), 2 * ONE_NUSD).await?.unwrap();
    assert_eq!(balance(&s.env.nusd, &bob).await?, 1_900_000, "5% agent-economy fee");
    assert_eq!(balance(&s.env.nusd, s.treasury.id()).await?, 100_000);

    s.owner.call(s.escrow.id(), "close").args_json(json!({"campaign_id": "c1"})).max_gas().transact().await?.into_result()?;
    assert_eq!(balance(&s.env.nusd, s.owner.id()).await?, 98 * ONE_NUSD, "90 kept + 8 unused refunded");
    assert!(pay(&s, &s.agent, bob.as_str(), ONE_NUSD).await?.is_none(), "closed campaign");
    Ok(())
}

#[tokio::test]
async fn failed_transfer_releases_reservation() -> anyhow::Result<()> {
    let s = setup().await?;
    // Allowlisted but not registered on nUSD: the transfer fails.
    let ghost = "ghost.test.near";
    s.owner.call(s.escrow.id(), "set_policy").args_json(json!({"campaign_id": "c1", "policy": {
        "auto_limit": (2 * ONE_NUSD).to_string(), "daily_limit": (3 * ONE_NUSD).to_string(), "allowlist": [ghost]}}))
        .transact().await?.into_result()?;
    pay(&s, &s.agent, ghost, ONE_NUSD).await?.unwrap();
    let p: Value = s.escrow.view("get_payment").args_json(json!({"payment_id": "1"})).await?.json()?;
    assert_eq!(p["status"], "Failed");
    let c = campaign(&s).await?;
    assert_eq!(c["reserved"], "0");
    assert_eq!(c["spent"], "0");
    assert_eq!(c["spent_today"], "0");
    Ok(())
}

#[tokio::test]
async fn failed_net_transfer_sends_no_fee() -> anyhow::Result<()> {
    // Security review H4: a Nearchant payee that can't receive must not leak the 5% fee to the treasury.
    let s = setup().await?;
    let unregistered: near_workspaces::AccountId = format!("zzz.nearchant.{}", s.env.root.id()).parse()?;
    s.owner.call(s.escrow.id(), "set_policy").args_json(json!({"campaign_id": "c1", "policy": {
        "auto_limit": (2 * ONE_NUSD).to_string(), "daily_limit": (3 * ONE_NUSD).to_string(), "allowlist": [unregistered]}}))
        .transact().await?.into_result()?;
    pay(&s, &s.agent, unregistered.as_str(), 2 * ONE_NUSD).await?.unwrap();
    let p: Value = s.escrow.view("get_payment").args_json(json!({"payment_id": "1"})).await?.json()?;
    assert_eq!(p["status"], "Failed");
    assert_eq!(balance(&s.env.nusd, s.treasury.id()).await?, 0, "no fee on a failed payment");
    assert_eq!(balance(&s.env.nusd, s.escrow.id()).await?, 10 * ONE_NUSD, "the budget is intact");
    Ok(())
}

#[tokio::test]
async fn tiny_campaigns_are_refused() -> anyhow::Result<()> {
    let s = setup().await?;
    let used: String = s.owner.call(s.env.nusd.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": s.escrow.id(), "amount": "10",
            "msg": json!({"action": "fund", "campaign_id": "spam", "agent_id": s.agent.id()}).to_string()}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?.json()?;
    assert_eq!(used, "0");
    Ok(())
}
