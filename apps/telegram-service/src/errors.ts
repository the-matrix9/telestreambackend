export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

interface RpcLike {
  errorMessage?: string;
  seconds?: number;
  message?: string;
  code?: number;
}

/** Translate GramJS / MTProto errors into stable, non-leaky service errors. */
export function mapTelegramError(err: unknown): ServiceError {
  if (err instanceof ServiceError) return err;
  const e = (err ?? {}) as RpcLike;
  const m = e.errorMessage ?? e.message ?? "";

  if (m.startsWith("FLOOD_WAIT") || m.startsWith("FLOOD_PREMIUM_WAIT") || typeof e.seconds === "number") {
    const seconds = e.seconds ?? Number(/(\d+)/.exec(m)?.[1] ?? 30);
    return new ServiceError(429, "telegram_flood_wait", `Telegram asked us to wait ${seconds}s before retrying.`, seconds);
  }
  switch (true) {
    case m.includes("PHONE_NUMBER_INVALID"): return new ServiceError(400, "phone_invalid", "Telegram rejected that phone number.");
    case m.includes("PHONE_NUMBER_BANNED"): return new ServiceError(403, "phone_banned", "This phone number is banned by Telegram.");
    case m.includes("PHONE_CODE_INVALID"): return new ServiceError(400, "code_invalid", "That login code is incorrect.");
    case m.includes("PHONE_CODE_EXPIRED"): return new ServiceError(400, "code_expired", "That login code has expired. Request a new one.");
    case m.includes("PHONE_CODE_EMPTY"): return new ServiceError(400, "code_invalid", "Enter the login code.");
    case m.includes("PASSWORD_HASH_INVALID"): return new ServiceError(400, "password_invalid", "The two-step verification password is incorrect.");
    case m.includes("SESSION_PASSWORD_NEEDED"): return new ServiceError(409, "password_required", "Two-step verification password required.");
    case m.includes("API_ID_INVALID"): return new ServiceError(500, "api_credentials_invalid", "TG_API_ID / TG_API_HASH were rejected by Telegram.");
    case m.includes("AUTH_KEY_UNREGISTERED") || m.includes("SESSION_REVOKED") || m.includes("SESSION_EXPIRED") || m.includes("USER_DEACTIVATED"):
      return new ServiceError(401, "session_revoked", "The Telegram session was revoked or expired. Sign in again.");
    case m.includes("CHANNEL_PRIVATE") || m.includes("CHANNEL_INVALID") || m.includes("CHAT_FORBIDDEN") || m.includes("CHAT_ADMIN_REQUIRED"):
      return new ServiceError(403, "channel_inaccessible", "This account cannot access that channel. Join it first, or check the ID.");
    case m.includes("USERNAME_NOT_OCCUPIED") || m.includes("USERNAME_INVALID") || m.includes("Could not find the input entity"):
      return new ServiceError(404, "channel_not_found", "No channel found with that ID or username. For private channels the account must already be a member.");
    case m.includes("FILE_REFERENCE") :
      return new ServiceError(502, "file_reference_expired", "Telegram file reference expired.");
    case m.includes("TIMEOUT") || m.includes("Timeout") || m.includes("ETIMEDOUT") || m.includes("ECONNRESET") || m.includes("Not connected"):
      return new ServiceError(503, "telegram_unavailable", "Telegram is temporarily unreachable.", 5);
    default:
      return new ServiceError(502, "telegram_error", "Telegram returned an unexpected error.");
  }
}
