import { Request, Response, NextFunction } from "express";
import { restService } from "./rest.service";
import {
  RestCreateOrderSchema,
  RestCreateWebhookSchema,
  RestUpdateWebhookSchema,
} from "./rest.schemas";
import { BadRequestError, UnauthorizedError } from "../../errors/AppError";

export class RestController {
  public async getServices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await restService.getServices(req.query);
      res.status(200).json({
        status: "success",
        data: result.services,
        pagination: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  }

  public async createOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const input = RestCreateOrderSchema.parse(req.body);
      const idempotencyKey =
        (req.headers["idempotency-key"] as string | undefined) ||
        (req.headers["x-idempotency-key"] as string | undefined);

      const result = await restService.createOrder(req.user.id, input, idempotencyKey?.trim());

      res.status(result.statusCode).json({
        status: "success",
        data: result.data,
      });
    } catch (err) {
      next(err);
    }
  }

  public async getOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const orderId = Number(req.params.id);
      if (isNaN(orderId) || !Number.isInteger(orderId) || orderId <= 0) {
        throw new BadRequestError("Order ID must be a valid positive integer");
      }

      const order = await restService.getOrder(req.user.id, orderId);

      res.status(200).json({
        status: "success",
        data: order,
      });
    } catch (err) {
      next(err);
    }
  }

  public async getBalance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const balanceData = await restService.getBalanceAndTransactions(req.user.id, req.query);

      res.status(200).json({
        status: "success",
        data: balanceData,
      });
    } catch (err) {
      next(err);
    }
  }

  public async listWebhooks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const webhooks = await restService.listWebhooks(req.user.id);

      res.status(200).json({
        status: "success",
        data: webhooks,
      });
    } catch (err) {
      next(err);
    }
  }

  public async createWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const input = RestCreateWebhookSchema.parse(req.body);
      const webhook = await restService.createWebhook(req.user.id, input);

      res.status(201).json({
        status: "success",
        data: webhook,
      });
    } catch (err) {
      next(err);
    }
  }

  public async getWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const webhookId = req.params.id;
      if (!webhookId) {
        throw new BadRequestError("Webhook ID is required");
      }

      const webhook = await restService.getWebhook(req.user.id, webhookId);

      res.status(200).json({
        status: "success",
        data: webhook,
      });
    } catch (err) {
      next(err);
    }
  }

  public async updateWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const webhookId = req.params.id;
      if (!webhookId) {
        throw new BadRequestError("Webhook ID is required");
      }

      const input = RestUpdateWebhookSchema.parse(req.body);
      const updated = await restService.updateWebhook(req.user.id, webhookId, input);

      res.status(200).json({
        status: "success",
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  }

  public async deleteWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const webhookId = req.params.id;
      if (!webhookId) {
        throw new BadRequestError("Webhook ID is required");
      }

      await restService.deleteWebhook(req.user.id, webhookId);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
}

export const restController = new RestController();
