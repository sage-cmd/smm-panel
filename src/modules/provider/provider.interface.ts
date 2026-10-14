export interface OrderPlacementRequest {
  orderId: number;
  serviceId: number;
  link: string;
  quantity: number;
}

export interface OrderPlacementResult {
  externalOrderId: string;
  startCount?: number;
  initialStatus: "PROCESSING" | "COMPLETED" | "PARTIAL";
}

export interface OrderStatusResult {
  externalOrderId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "CANCELED" | "PARTIAL";
  remains: number;
  startCount?: number;
  charge?: string;
}

export interface ISMMProvider {
  /**
   * Places an order with the external provider.
   */
  createOrder(req: OrderPlacementRequest): Promise<OrderPlacementResult>;

  /**
   * Fetches latest order status from the external provider.
   */
  getOrderStatus(externalOrderId: string): Promise<OrderStatusResult>;
}
