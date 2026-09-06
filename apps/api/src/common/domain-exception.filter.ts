import {
  ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger,
} from "@nestjs/common";
import { IllegalTransitionError } from "@wcb/core";
import type { Response } from "express";

/**
 * An illegal status transition is a client mistake, not a server fault.
 *
 * Without this the guard's error escapes as a 500 and the caller sees
 * "Internal server error" - which tells a rider nothing about why the tap did
 * not work. Mapping it to 422 with the actual transition keeps the guard
 * strict while making the refusal legible.
 */
@Catch(IllegalTransitionError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(err: IllegalTransitionError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    this.logger.warn(err.message);
    res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      error: "Illegal status change",
      message: humanise(err),
      field: err.field,
      from: err.from,
      to: err.to,
    });
  }
}

/** Say what the operator should do, not just what failed. */
function humanise(err: IllegalTransitionError): string {
  const from = err.from.replace(/_/g, " ").toLowerCase();
  const to = err.to.replace(/_/g, " ").toLowerCase();
  if (err.field === "fulfillment" && err.to === "OUT_FOR_DELIVERY") {
    return `This order is "${from}" — it has to be confirmed, packed and assigned before a rider can start the trip.`;
  }
  if (err.field === "fulfillment" && err.to === "DELIVERED") {
    return `This order is "${from}" — the trip has to be started before it can be completed.`;
  }
  if (err.field === "payment" && err.from === "PAID") {
    return "This order is already paid; its payment status cannot be moved backwards.";
  }
  return `An order that is "${from}" cannot move straight to "${to}".`;
}
