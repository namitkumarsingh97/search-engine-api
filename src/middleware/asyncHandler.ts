import { NextFunction, Request, RequestHandler, Response } from "express";

/** Express 4 doesn't catch rejected promises from async handlers; this forwards them to the error middleware. */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res, next).catch(next);
  };
}
