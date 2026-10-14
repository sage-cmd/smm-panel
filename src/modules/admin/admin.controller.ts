import { Request, Response, NextFunction } from "express";
import { adminService } from "./admin.service";
import {
  AdminServiceIdParamSchema,
  AdminCreateServiceSchema,
  AdminGetServicesQuerySchema,
  AdminUpdateServiceSchema,
  AdminUserIdParamSchema,
  AdminGetUsersQuerySchema,
  AdminAdjustBalanceSchema,
  AdminUpdateUserStatusSchema,
  AdminOrderIdParamSchema,
  AdminGetOrdersQuerySchema,
  AdminUpdateOrderStatusSchema,
} from "./admin.schemas";
import { UnauthorizedError } from "../../errors/AppError";

export class AdminController {
  // ==============================================================================
  // Services
  // ==============================================================================

  public async createService(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = AdminCreateServiceSchema.parse(req.body);
      const service = await adminService.createService(input);

      res.status(201).json({
        status: "success",
        data: service,
      });
    } catch (err) {
      next(err);
    }
  }

  public async getServices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = AdminGetServicesQuerySchema.parse(req.query);
      const result = await adminService.getServices(query);

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  public async updateService(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = AdminServiceIdParamSchema.parse(req.params);
      const input = AdminUpdateServiceSchema.parse(req.body);

      const service = await adminService.updateService(id, input);

      res.status(200).json({
        status: "success",
        data: service,
      });
    } catch (err) {
      next(err);
    }
  }

  public async deleteService(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = AdminServiceIdParamSchema.parse(req.params);
      const result = await adminService.deleteService(id);

      res.status(200).json({
        status: "success",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  // ==============================================================================
  // Users
  // ==============================================================================

  public async getUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = AdminGetUsersQuerySchema.parse(req.query);
      const result = await adminService.getUsers(query);

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  public async adjustUserBalance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const { id: targetUserId } = AdminUserIdParamSchema.parse(req.params);
      const input = AdminAdjustBalanceSchema.parse(req.body);

      const result = await adminService.adjustUserBalance(req.user.id, targetUserId, input);

      res.status(200).json({
        status: "success",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  public async updateUserStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError("Authentication required");
      }

      const { id: targetUserId } = AdminUserIdParamSchema.parse(req.params);
      const input = AdminUpdateUserStatusSchema.parse(req.body);

      const result = await adminService.updateUserStatus(req.user.id, targetUserId, input);

      res.status(200).json({
        status: "success",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  // ==============================================================================
  // Orders
  // ==============================================================================

  public async getOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = AdminGetOrdersQuerySchema.parse(req.query);
      const result = await adminService.getOrders(query);

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  public async updateOrderStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: orderId } = AdminOrderIdParamSchema.parse(req.params);
      const input = AdminUpdateOrderStatusSchema.parse(req.body);

      const result = await adminService.updateOrderStatus(orderId, input);

      res.status(200).json({
        status: "success",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  // ==============================================================================
  // Stats
  // ==============================================================================

  public async getStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stats = await adminService.getStats();

      res.status(200).json({
        status: "success",
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  }
}

export const adminController = new AdminController();
