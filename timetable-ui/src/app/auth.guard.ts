import { inject } from '@angular/core';
import { CanActivateFn, GuardResult, Router, UrlTree } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AuthService } from './auth.service';

/** Redirects to /login when there's no signed-in user, and to /change-password when a temporary
 *  password hasn't been replaced yet (except for the change-password route itself). A stored
 *  token whose user profile hasn't been fetched yet (e.g. right after a page reload) is resolved
 *  via `refreshMe()` before deciding — an invalid/expired token then falls through to /login. */
export const authGuard: CanActivateFn = (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const toLogin = (): UrlTree =>
    router.createUrlTree(['/login'], { queryParams: { redirectTo: state.url } });

  if (!auth.isAuthenticated()) {
    return toLogin();
  }

  const decide = () =>
    auth.mustChangePassword() && state.url !== '/change-password'
      ? router.createUrlTree(['/change-password'])
      : true;

  if (auth.currentUser()) {
    return decide();
  }
  return auth.refreshMe().pipe(
    map((user) => {
      // `me` answering null is not "an anonymous visitor" here — we hold a token and just sent it,
      // so the only way to be nobody is for that token to have stopped working. Reading it as
      // success is what used to let an expired session walk straight into the app: `decide()` saw
      // no `mustChangePassword` on a null user and returned true.
      if (user === null) {
        // `authInterceptor` may already have recorded a more precise reason from the response that
        // just came back (TOKEN_EXPIRED, ACCOUNT_DISABLED); don't overwrite it with a guess.
        auth.clearSession(auth.sessionEndReason() ?? 'INVALID_TOKEN');
        return toLogin();
      }
      return decide();
    }),
    catchError(() => {
      auth.clearSession(auth.sessionEndReason() ?? 'INVALID_TOKEN');
      return of(toLogin());
    })
  );
};

/**
 * Guards /admin: requires an authenticated administrator.
 *
 * It has to be able to *wait*. Angular runs a route's `canActivate` guards concurrently and takes
 * the first non-`true` result in declaration order — so this one used to answer from an empty
 * session while `authGuard`, beside it, was still fetching the profile. `isAdmin()` read `null`,
 * this returned a redirect, and the redirect won: a bookmarked or reloaded `/admin` always bounced
 * to the faculty home, and the page could only be reached by clicking the sidebar link from inside
 * an already-loaded app. Resolving `me` here costs nothing extra — `AuthService.refreshMe` shares
 * one request between however many callers ask in the same tick.
 */
export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const decide = (): GuardResult => auth.isAdmin() ? true : router.createUrlTree(['/']);

  // Not signed in at all is `authGuard`'s answer to give, not this one's; deciding here would send
  // an anonymous visitor to the faculty home instead of to the login page they can act on.
  if (!auth.isAuthenticated() || auth.currentUser()) return decide();

  return auth.refreshMe().pipe(map(() => decide()), catchError(() => of(decide())));
};
