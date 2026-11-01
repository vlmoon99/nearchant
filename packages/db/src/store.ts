/** Off-chain shop data. Money state lives on chain; this mirrors it and holds catalog + briefs. */

export interface Service {
  id: string;
  handle: string;
  title: string;
  description: string;
  /** Price in token base units (U128 string). */
  priceUnits: string;
  deliveryHours: number;
  active: boolean;
  /** Agent Environment serving this service over A2A; absent = normal order flow. */
  agentEnv?: string | null;
}

export type OrderState = "awaiting_payment" | "paid" | "in_progress" | "delivered" | "released" | "refunded" | "cancelled";

export interface OrderRow {
  orderId: string;
  handle: string;
  serviceId: string;
  amount: string;
  brief: string;
  buyerAccountId: string | null;
  state: OrderState;
  createdAt: string;
  updatedAt: string;
}

export interface Store {
  listServices(handle: string): Promise<Service[]>;
  getService(handle: string, id: string): Promise<Service | null>;
  upsertService(s: Service): Promise<void>;
  createOrder(o: OrderRow): Promise<void>;
  getOrder(orderId: string): Promise<OrderRow | null>;
  /** Moves an order forward only from `from`; returns false if it was not in that state (idempotent updates). */
  transitionOrder(orderId: string, from: OrderState, to: OrderState): Promise<boolean>;
}

export class MemoryStore implements Store {
  private services = new Map<string, Service>();
  private orders = new Map<string, OrderRow>();

  async listServices(handle: string) {
    return [...this.services.values()].filter((s) => s.handle === handle && s.active);
  }
  async getService(handle: string, id: string) {
    const s = this.services.get(id);
    return s && s.handle === handle ? s : null;
  }
  async upsertService(s: Service) {
    this.services.set(s.id, { ...s });
  }
  async createOrder(o: OrderRow) {
    if (this.orders.has(o.orderId)) throw new Error("duplicate order id");
    this.orders.set(o.orderId, { ...o });
  }
  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o ? { ...o } : null;
  }
  async transitionOrder(id: string, from: OrderState, to: OrderState) {
    const o = this.orders.get(id);
    if (!o || o.state !== from) return false;
    o.state = to;
    o.updatedAt = new Date().toISOString();
    return true;
  }
}
