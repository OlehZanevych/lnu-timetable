import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { AuthService, SessionEndReason } from './auth.service';

/** The header `AuthenticationGraphQlInterceptor` sets when a presented token could not be honoured. */
const AUTH_ERROR_HEADER = 'X-Auth-Error';

const REASONS: SessionEndReason[] = ['TOKEN_EXPIRED', 'INVALID_TOKEN', 'ACCOUNT_DISABLED'];

function asReason(value: string | null | undefined): SessionEndReason | null {
  return value != null && (REASONS as string[]).includes(value) ? (value as SessionEndReason) : null;
}

/**
 * Reads the service's verdict on the token we sent. It is stated in two places on purpose — the
 * header survives a body this client never looks at (and is readable cross-origin because
 * `CorsFilter` names it in `Access-Control-Expose-Headers`), while the GraphQL error entry travels
 * with the response for any client that only ever parses the body. Either is enough.
 */
function authFailureOf(response: HttpResponse<unknown> | HttpErrorResponse): SessionEndReason | null {
  const fromHeader = asReason(response.headers.get(AUTH_ERROR_HEADER));
  if (fromHeader) return fromHeader;

  const body = response instanceof HttpResponse ? response.body : response.error;
  const errors = (body as { errors?: { extensions?: Record<string, unknown> }[] } | null)?.errors;
  const unauthenticated = errors?.find((e) => e?.extensions?.['code'] === 'UNAUTHENTICATED');
  if (!unauthenticated) return null;

  // `authError` names which of the three it was; an `UNAUTHENTICATED` raised by a data fetcher
  // (rather than by the token itself) carries no such detail, and is an invalid session either way.
  return asReason(unauthenticated.extensions?.['authError'] as string) ?? 'INVALID_TOKEN';
}

/**
 * Attaches the signed-in user's JWT to every outgoing request, and ends the session when the reply
 * says that token is no longer good for anything.
 *
 * Both halves matter. Outbound, `tokenForRequest()` refuses to send a token already past its `exp`,
 * so an expired session is over before it costs a round trip. Inbound, the service's own verdict is
 * what catches everything the client cannot work out alone — a rotated signing key, disagreeing
 * clocks, an account deactivated while its owner was mid-session — because it is the service, not
 * the browser, that decides whether a token is worth anything.
 *
 * This is the piece that was missing: an expired token used to be dropped silently on the server,
 * `Query.me` answered `null`, and nothing anywhere turned that into a sign-out.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);

  const token = auth.tokenForRequest();
  const authorized = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authorized).pipe(
    tap({
      next: (event) => {
        if (event instanceof HttpResponse) {
          const reason = authFailureOf(event);
          if (reason) auth.endSession(reason);
        }
      },
      error: (err) => {
        if (err instanceof HttpErrorResponse) {
          const reason = authFailureOf(err) ?? (err.status === 401 ? 'INVALID_TOKEN' : null);
          if (reason) auth.endSession(reason);
        }
      }
    })
  );
};
