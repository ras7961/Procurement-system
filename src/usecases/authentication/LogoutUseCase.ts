import type { TokenServiceInterface } from "@/interfaces/services/TokenServiceInterface";
import type { LogoutInput, LogoutResultDto } from "./dtos";

/**
 * Logout (ODD AuthenticationController: logout).
 *
 * Two parts, split across the layers:
 *  - here: ask the token service to invalidate the presented token (a no-op for a missing token
 *    or for a stateless implementation);
 *  - the future HTTP adapter: always clear the client's cookie or token, which is what the
 *    returned `clearCredentials: true` tells it to do.
 *
 * Logging out twice, or without a token, is not an error. If the token service itself fails,
 * the error is passed on so the adapter can report it, and the adapter still clears the cookie.
 */
export class LogoutUseCase {
  constructor(private readonly tokens: TokenServiceInterface) {}

  async execute(input: LogoutInput = {}): Promise<LogoutResultDto> {
    const token = input?.token;
    if (typeof token === "string" && token !== "") {
      await this.tokens.revoke(token);
    }
    return { clearCredentials: true };
  }
}
