import { Request, Response, NextFunction } from "express";
import { legacyService } from "./legacy.service";
import {
  LegacyActionSchema,
  LegacyAddOrderSchema,
  LegacyOrderStatusSchema,
} from "./legacy.schemas";
import { BadRequestError, UnauthorizedError } from "../../errors/AppError";

export async function handleLegacyRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      throw new UnauthorizedError("Authentication required");
    }

    const { action } = LegacyActionSchema.parse(req.body);

    switch (action) {
      case "balance": {
        const balanceData = await legacyService.getBalance(user.id);
        res.status(200).json(balanceData);
        return;
      }

      case "services": {
        const servicesData = await legacyService.getServices();
        res.status(200).json(servicesData);
        return;
      }

      case "add": {
        const addOrderInput = LegacyAddOrderSchema.parse(req.body);
        const orderResult = await legacyService.addOrder(user.id, addOrderInput);
        res.status(200).json(orderResult);
        return;
      }

      case "status": {
        const statusInput = LegacyOrderStatusSchema.parse(req.body);
        const statusResult = await legacyService.getOrderStatus(user.id, statusInput);
        res.status(200).json(statusResult);
        return;
      }

      default: {
        throw new BadRequestError("Incorrect request");
      }
    }
  } catch (err) {
    next(err);
  }
}
