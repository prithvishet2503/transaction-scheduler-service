import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wrap an async route handler so rejections reach Express's error middleware
 * (Express 4 does not forward async rejections on its own). Mirrors
 * wallet-platform's `ph(...)` promise-handler convention.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
