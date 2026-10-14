import { Router } from "express";
import { authenticateApiKey } from "../../middleware/auth";
import { handleLegacyRequest } from "./legacy.controller";

export const legacyRouter = Router();

// Route: POST /api/v1
legacyRouter.post("/", authenticateApiKey, handleLegacyRequest);
