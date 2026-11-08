export { EscrowClient, newOrderId, type EscrowOptions, type PayInput, type PayResult } from "./escrow.js";
export { orderStage, type Role, type Stage } from "./stage.js";
export { EscrowError, ORDER_STATUSES, parseOrder, parseParams, type Order, type OrderStatus, type Params } from "./types.js";
export { accountSigner, keySigner, rpcProvider, rpcView, DEFAULT_RPC, type Network, type Signer, type View, type RpcOptions } from "./near.js";
export { retry, withTimeout, TimeoutError, type RetryOptions } from "./retry.js";

/** The `msg` the escrow expects in `ft_transfer_call`, if you build the transaction yourself (e.g. a wallet). */
export function orderMsg(orderId: string, seller: string): string {
  return JSON.stringify({ order_id: orderId, seller });
}
