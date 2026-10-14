import { Router } from "express";
import { authenticateApiKey } from "../../middleware/auth";
import { restController } from "./rest.controller";

export const restRouter = Router();

// Enforce authentication on all REST API endpoints
restRouter.use(authenticateApiKey);

// Services
restRouter.get("/services", restController.getServices.bind(restController));

// Orders
restRouter.post("/orders", restController.createOrder.bind(restController));
restRouter.get("/orders/:id", restController.getOrder.bind(restController));

// Balance & Ledger Summary
restRouter.get("/balance", restController.getBalance.bind(restController));

// Webhooks
restRouter.get("/webhooks", restController.listWebhooks.bind(restController));
restRouter.post("/webhooks", restController.createWebhook.bind(restController));
restRouter.get("/webhooks/:id", restController.getWebhook.bind(restController));
restRouter.patch("/webhooks/:id", restController.updateWebhook.bind(restController));
restRouter.delete("/webhooks/:id", restController.deleteWebhook.bind(restController));
