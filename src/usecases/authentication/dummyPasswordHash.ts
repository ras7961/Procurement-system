/**
 * A valid Argon2id hash of a random, discarded password, produced once with the library
 * defaults (m=65536, t=3, p=4), the same parameters Argon2PasswordService uses.
 *
 * LoginUseCase verifies the submitted password against it when the email is unknown, so an
 * unknown email costs about as much time as a known one. It is not a credential: nobody
 * knows the password it was made from. If the hashing parameters ever change, generate a new
 * one (a unit test fails when the parameters differ).
 *
 * RegisterSupplier and CreateUserAccount also use it as a throw-away placeholder while
 * validating input before the real, slow hashing.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$6Z4uh09s6VOc5iJDdIUaAg$ng+ViOP6tl9MLHC1nody2T29BjaV/Yd55wAfcliXKs4";
