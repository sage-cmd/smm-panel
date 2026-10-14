import { Router } from "express";
import { authenticateApiKey } from "../middleware/auth";
import { adminAuthMiddleware } from "../middleware/adminAuthMiddleware";
import { adminController } from "../modules/admin/admin.controller";

export const adminRouter = Router();

// Enforce both API key authentication and Admin role authorization on all admin routes
adminRouter.use(authenticateApiKey);
adminRouter.use(adminAuthMiddleware);

// ==============================================================================
// Service Catalog Admin Endpoints
// ==============================================================================

// POST /services -> Create new service
adminRouter.post("/services", adminController.createService.bind(adminController));

// GET /services -> List paginated services with optional filters
adminRouter.get("/services", adminController.getServices.bind(adminController));

// PATCH /services/:id -> Update existing service
adminRouter.patch("/services/:id", adminController.updateService.bind(adminController));

// DELETE /services/:id -> Soft delete service
adminRouter.delete("/services/:id", adminController.deleteService.bind(adminController));

// ==============================================================================
// User Management Admin Endpoints
// ==============================================================================

// GET /users -> List paginated users with filters
adminRouter.get("/users", adminController.getUsers.bind(adminController));

// PATCH /users/:id/balance -> Adjust user balance (credit/debit)
adminRouter.patch("/users/:id/balance", adminController.adjustUserBalance.bind(adminController));

// PATCH /users/:id/status -> Ban/unban user account
adminRouter.patch("/users/:id/status", adminController.updateUserStatus.bind(adminController));

// ==============================================================================
// Order Management Admin Endpoints
// ==============================================================================

// GET /orders -> List paginated orders with filters
adminRouter.get("/orders", adminController.getOrders.bind(adminController));

// PATCH /orders/:id/status -> Transition order status (and handle cancellation refund)
adminRouter.patch("/orders/:id/status", adminController.updateOrderStatus.bind(adminController));

// ==============================================================================
// Platform Statistics Admin Endpoints
// ==============================================================================

// GET /stats -> Platform statistics overview
adminRouter.get("/stats", adminController.getStats.bind(adminController));
