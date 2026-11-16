import { AuthenticationRequiredException, UserNotFoundException } from "@/entities/exceptions";
import type { TokenServiceInterface } from "@/interfaces/services/TokenServiceInterface";
import type { GetCurrentUserUseCase } from "./GetCurrentUserUseCase";
import type { AuthenticateSessionInput, UserResponseDto } from "./dtos";

/**
 * Turns a session token into the authenticated user (ODD AuthenticationUseCase: validating a
 * session). Not named in the ODD; added in Stage 1E so that controllers, which may only use
 * use cases, have one place that answers "who is calling?" for every protected operation.
 *
 * 1. A missing or empty token, or one the token service rejects (malformed, forged, expired,
 *    revoked), gives AuthenticationRequiredException. All of these look the same to the caller.
 * 2. Only the user id from the token is used. The role in the token is ignored: the account and
 *    its role are read again from storage by GetCurrentUserUseCase, which also rejects accounts
 *    that are no longer allowed to authenticate (AccountInactiveException).
 * 3. A token for an account that no longer exists is not a valid session either.
 *
 * If the token service cannot check revocation (for example the database is down) its error is
 * passed on: the request fails, it is never treated as authenticated. This use case never logs.
 */
export class AuthenticateSessionUseCase {
  constructor(
    private readonly tokens: TokenServiceInterface,
    private readonly currentUser: GetCurrentUserUseCase,
  ) {}

  async execute(input: AuthenticateSessionInput): Promise<UserResponseDto> {
    const token = input?.token;
    if (typeof token !== "string" || token === "") throw new AuthenticationRequiredException();

    const claims = await this.tokens.verify(token);
    if (claims === null) throw new AuthenticationRequiredException();

    try {
      return await this.currentUser.execute({ userId: claims.userId });
    } catch (error) {
      if (error instanceof UserNotFoundException) throw new AuthenticationRequiredException();
      throw error;
    }
  }
}
