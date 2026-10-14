import {
  ISMMProvider,
  OrderPlacementRequest,
  OrderPlacementResult,
  OrderStatusResult,
} from "./provider.interface";

export class MockSMMProvider implements ISMMProvider {
  public async createOrder(req: OrderPlacementRequest): Promise<OrderPlacementResult> {
    // Generate realistic external mock order reference
    const externalOrderId = `mock_ext_${req.orderId}_${Date.now()}`;
    return {
      externalOrderId,
      startCount: Math.floor(Math.random() * 500),
      initialStatus: "PROCESSING",
    };
  }

  public async getOrderStatus(externalOrderId: string): Promise<OrderStatusResult> {
    return {
      externalOrderId,
      status: "COMPLETED",
      remains: 0,
      startCount: 100,
    };
  }
}

export const defaultProvider: ISMMProvider = new MockSMMProvider();
