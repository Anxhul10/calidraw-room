import { Request, Response, NextFunction } from "express";

export interface AuthenticatedUser {
  id: string;
  name?: string;
  isGuest?: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;

  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const key = parts[0]?.trim();
    const val = parts.slice(1).join("=").trim();
    if (key) {
      list[key] = decodeURIComponent(val);
    }
  });

  return list;
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // 1. Check x-user-id header
  const headerUserId = req.header("x-user-id");
  if (headerUserId && headerUserId.trim()) {
    req.user = { id: headerUserId.trim() };
    return next();
  }

  // 2. Check Authorization Bearer header
  const authHeader = req.header("authorization") || req.header("Authorization");
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      req.user = { id: token };
      return next();
    }
  }

  // 3. Check cookies (e.g. excplus-auth)
  const cookies = parseCookies(req.headers.cookie);
  if (cookies["excplus-auth"]) {
    req.user = { id: cookies["excplus-auth"] };
    return next();
  }
  if (cookies["auth_token"]) {
    req.user = { id: cookies["auth_token"] };
    return next();
  }

  // Default guest user id if none passed
  req.user = { id: "user_default", isGuest: true };
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    });
  }
  next();
}
